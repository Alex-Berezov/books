import { Injectable } from '@nestjs/common';
import { BookDossier, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { SUMMARY_INPUT_CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { allChapters } from '../chapter-pages';
import { callShaped, ShapedAnswer } from '../llm-shaped-call';
import { sourceFingerprint } from '../source-fingerprint';
import {
  DOSSIER_INVALID_RESPONSE,
  DOSSIER_SOURCE_CHANGED,
  DOSSIER_STAGE,
  DOSSIER_TOO_LONG,
  GLOSSARY_STAGE,
} from './dossier.constants';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import {
  DOSSIER_FORMAT_VERSION,
  DOSSIER_PART_SHAPE,
  assembleDossier,
  DOSSIER_MERGE_SHAPE,
  DOSSIER_SHAPE,
  dossierChapterErrors,
  dossierMergeErrors,
  GLOSSARY_SHAPE,
  GroupLists,
  missingChapters,
  Shape,
  withoutAssembledFields,
} from './dossier.format';
import {
  distinctChapters,
  dossierListLimits,
  exceedsChapterCap,
  GroupItem,
  groupSectionCap,
  levelNarrows,
  packGroups,
  measureSummaryEntry,
  upperLevelBlocked,
} from './dossier-groups';
import {
  DossierPlanEntry,
  nextPlannedPart,
  planPartsCount,
  partKey,
  planChapterParts,
  readPlan,
} from './dossier-parts';
import {
  dossierPartRequest,
  emptyMergeInputChars,
  dossierSummaryRequest,
  glossaryRequest,
  ShapedRequest,
  summaryInputEstimator,
} from './dossier.prompts';
import { DossierBuilderService } from './dossier-builder.service';
import { dossierTaskInput, glossaryTaskInput } from './dossier-task-input';

function payloadId(task: LlmTask, key: 'dossierId' | 'glossaryId'): string | null {
  const payload = task.payload as Record<string, unknown> | null;
  const id = payload?.[key];
  return typeof id === 'string' ? id : null;
}

/**
 * Шаги построения досье и глоссария (`F05-2`, шаг 7). Досье - по куску главы за шаг
 * (`continue`), затем сводка; глоссарий - один шаг. Каждый вызов - под операцией строителя
 * с опциями исполнителя: аренда продлевается перед каждой попыткой.
 *
 * 🔴 Частичное досье пишется до записи итога шага и условием по аренде (`renewLease`): упал
 * после ответа - повтор найдёт кусок сохранённым и модель не позовёт (решение арбитра
 * `F05 | F05-2`, В3). Строка `ready` - условием по строителю: перехваченную строку прежний
 * строитель не допишет (`L-019`).
 */
@Injectable()
export class DossierTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly builder: DossierBuilderService,
  ) {}

  readonly dossierHandler: LlmTaskHandler = {
    run: (task, ctx) => this.runDossier(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason, 'bookDossier'),
  };

  readonly glossaryHandler: LlmTaskHandler = {
    run: (task, ctx) => this.runGlossary(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason, 'bookGlossary'),
  };

  /** «Продолжить» операцию вида `dossier`: шаг строки, которую она строит (В5). */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const dossier = await this.prisma.bookDossier.findFirst({
      where: { operationId: op.id, status: 'building' },
      select: { id: true, sourceVersionId: true },
    });
    if (dossier) return [dossierTaskInput(dossier.id, dossier.sourceVersionId, op.id)];
    const glossary = await this.prisma.bookGlossary.findFirst({
      where: { operationId: op.id, status: 'building' },
      select: { id: true, language: true, dossier: { select: { sourceVersionId: true } } },
    });
    if (!glossary) return [];
    return [
      glossaryTaskInput(glossary.id, glossary.language, glossary.dossier.sourceVersionId, op.id),
    ];
  }

  /** Отменённый строитель: строка `failed`, перехвата нет (Р20). */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    const where = { operationId: op.id, status: 'building' as const };
    await tx.bookDossier.updateMany({ where, data: { status: 'failed' } });
    await tx.bookGlossary.updateMany({ where, data: { status: 'failed' } });
  }

  /**
   * Текст исходника правили посреди построения: перехват такой строки бессмыслен, куски уже
   * не те. Строка закрывается вместе с операцией, следующий запрос строит новое поколение.
   */
  private async sourceChanged(rowId: string, operationId: string): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(operationId, async (tx) => {
      await this.builder.failRow('bookDossier', rowId, operationId, tx, {
        failedReason: DOSSIER_SOURCE_CHANGED,
      });
    });
    return { kind: 'fail', reason: DOSSIER_SOURCE_CHANGED };
  }

  private async runDossier(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = payloadId(task, 'dossierId');
    const row = id ? await this.prisma.bookDossier.findUnique({ where: { id } }) : null;
    if (row?.status === 'ready' && row.operationId === task.operationId) {
      // Строка уже `ready`, а процесс упал до закрытия операции: шаг закрывает её сам.
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    // Строки нет (версию удалили - каскад): строить нечего, операция закрывается отказом.
    if (!row) {
      await this.tasks.failOperation(task.operationId);
      return { kind: 'done' };
    }
    // Строку перехватили или она уже не строится: шаг этой задачи больше никому не нужен.
    if (row.status !== 'building' || row.operationId !== task.operationId) {
      return { kind: 'done' };
    }
    if ((await sourceFingerprint(this.prisma, row.sourceVersionId)) !== row.fingerprint) {
      return this.sourceChanged(row.id, task.operationId);
    }
    const plan = readPlan(row.plan);
    const savedKeys = await this.prisma.bookDossierPart.findMany({
      where: { dossierId: row.id },
      select: { chapterNumber: true, partIndex: true },
      take: planPartsCount(plan),
    });
    const next = nextPlannedPart(
      plan,
      new Set(savedKeys.map((p) => partKey(p.chapterNumber, p.partIndex))),
    );

    if (next) {
      // Читается только глава этого куска: шаг не тянет всю книгу.
      const chapter = await this.prisma.chapter.findUnique({
        where: {
          bookVersionId_number: { bookVersionId: row.sourceVersionId, number: next.chapterNumber },
        },
        select: { number: true, title: true, content: true },
      });
      const part = chapter ? planChapterParts(chapter)[next.partIndex] : undefined;
      if (!part) {
        return this.sourceChanged(row.id, task.operationId);
      }
      const answer = await this.callShaped(
        task.operationId,
        DOSSIER_STAGE,
        dossierPartRequest(part),
        DOSSIER_PART_SHAPE,
        ctx,
      );
      if (!answer.ok) {
        await this.failBuild('bookDossier', row.id, task.operationId, row.takeovers);
        return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
      }
      await ctx.renewLease();
      await this.prisma.bookDossierPart.createMany({
        data: [
          {
            dossierId: row.id,
            chapterNumber: part.chapterNumber,
            partIndex: part.partIndex,
            data: answer.value as Prisma.InputJsonValue,
            callId: answer.callId,
          },
        ],
        skipDuplicates: true,
      });
      return { kind: 'continue' };
    }

    return this.summarize(row, plan, task, ctx);
  }

  /**
   * Сводка (`F05-Rb`). Вход влезает в контекст и глав не больше `groupChapterCap` - один вызов,
   * как раньше. Иначе - группы подряд идущих элементов, каждая своим шагом, затем те же правила
   * к результатам групп: уровень с одним вызовом и есть итог. `chapters` и `summaryPlan` пишут
   * только группы уровня 0, не больше `groupChapterCap` глав каждая; выше и в итоге их склеивает
   * код (`assembleDossier`), остальные списки ограничены промптом от `maxTokens` (решения
   * арбитра `F05 | F05-12`); соблюдает ли модель потолки - живой прогон не подтвердил (`LEGACY-477`). Строки групп уровня заводятся разом, поэтому границы не плывут, если
   * модель этапа сменили посреди построения; результат группы пишется после продления аренды, и
   * повтор шага её не оплачивает.
   */
  private async summarize(
    row: BookDossier,
    plan: DossierPlanEntry[],
    task: LlmTask,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const planned = plan.map((e) => e.chapterNumber);
    const partsTotal = planPartsCount(plan);
    const { maxTokens } = await this.llm.getStageSetting(DOSSIER_STAGE);
    const limits = dossierListLimits(maxTokens);
    // Верхний уровень - отдельным запросом, строки - только его: на уровне групп не больше, чем
    // элементов уровня ниже, то есть не больше кусков плана.
    const top = await this.prisma.bookDossierGroup.aggregate({
      where: { dossierId: row.id },
      _max: { level: true },
    });
    const topLevel = top._max.level ?? -1;
    const groups =
      topLevel < 0
        ? []
        : await this.prisma.bookDossierGroup.findMany({
            where: { dossierId: row.id, level: topLevel },
            select: {
              id: true,
              level: true,
              firstItem: true,
              itemCount: true,
              firstChapter: true,
              lastChapter: true,
              done: true,
            },
            orderBy: { groupIndex: 'asc' },
            take: partsTotal,
          });
    const pending = groups.find((g) => !g.done);

    if (pending) {
      const items = await this.loadItems(
        row.id,
        pending.level - 1,
        pending.firstItem,
        pending.itemCount,
      );
      // Шаг группы читает только названия своих глав.
      const own = await allChapters(
        this.prisma,
        row.sourceVersionId,
        { number: true, title: true },
        { from: pending.firstChapter, to: pending.lastChapter },
      );
      const ownNumbers = own.map((c) => c.number);
      const ownPlanned = planned.filter(
        (n) => n >= pending.firstChapter && n <= pending.lastChapter,
      );
      // Списки глав и разделов пишет только уровень 0 (`F05-12`), разделов - своей долей потолка.
      const isLevel0 = pending.level === 0;
      const request = dossierSummaryRequest({
        chapters: own,
        parts: items.map((i) => i.entry),
        merge: !isLevel0,
        limits,
        maxSections: groupSectionCap(ownPlanned.length, planned.length, groups.length),
      });
      const stage = await this.summaryFit(request);
      // Заведённую группу не перепаковывают (Р4 `F05 | F05-Rb`): если `maxTokens` этапа снизили
      // посреди построения и её главы больше не помещаются в ответ, - отказ до вызова (`F05-12`).
      if (!stage.fits || (isLevel0 && exceedsChapterCap(ownPlanned.length, maxTokens))) {
        return this.failTooLong(row, task, stage.model);
      }
      const answer = await this.callShaped(
        task.operationId,
        DOSSIER_STAGE,
        request,
        isLevel0 ? DOSSIER_SHAPE : DOSSIER_MERGE_SHAPE,
        ctx,
        (value) =>
          isLevel0
            ? dossierChapterErrors(value, ownPlanned, ownNumbers)
            : dossierMergeErrors(value, ownNumbers),
      );
      if (!answer.ok) {
        await this.failBuild('bookDossier', row.id, task.operationId, row.takeovers);
        return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
      }
      await ctx.renewLease();
      const data = isLevel0 ? answer.value : withoutAssembledFields(answer.value as object);
      await this.prisma.bookDossierGroup.updateMany({
        where: { id: pending.id, done: false },
        data: { done: true, data: data as Prisma.InputJsonValue, callId: answer.callId },
      });
      return { kind: 'continue' };
    }

    const titles = await allChapters(this.prisma, row.sourceVersionId, {
      number: true,
      title: true,
    });
    const titleNumbers = titles.map((c) => c.number);
    const items = await this.loadItems(
      row.id,
      topLevel,
      0,
      topLevel < 0 ? partsTotal : groups.length,
    );
    // Над группами итог пишет досье без списков глав и разделов - их склеивает код.
    const isMerge = topLevel >= 0;
    const summary = dossierSummaryRequest({
      chapters: titles,
      parts: items.map((i) => i.entry),
      merge: isMerge,
      limits,
    });
    const stage = await this.summaryFit(summary);
    // Без групп одна сводка перечислила бы все главы одним ответом - больше предела глав нельзя.
    const hasTooManyChapters = !isMerge && exceedsChapterCap(planned.length, maxTokens);
    if (!stage.fits || hasTooManyChapters) {
      // Группа меряется с названиями всех глав, как итоговая сводка: иначе группы влезли бы,
      // а итог из их ответов - нет, и отказ пришёл бы после оплаты всех групп. Граница и мерки
      // элементов (длина и номера границ ограды, `F05-14`) - один раз, проба - сложение
      // (Р6 `F05 | F05-Rb`): упаковка не ходит в базу, не сериализует вход на каждой пробе и не
      // переживает аренду.
      const { maxInputChars } = await this.llm.stageInputCeiling(DOSSIER_STAGE, {
        charsPerToken: SUMMARY_INPUT_CHARS_PER_TOKEN,
      });
      const level = topLevel + 1;
      const estimate = summaryInputEstimator({ chapters: titles, merge: isMerge, limits });
      const measured = new Map(items.map((i) => [i, measureSummaryEntry(i.entry)]));
      const spans = await packGroups(items, (group) =>
        Promise.resolve(
          (maxInputChars === null ||
            estimate(group.map((i) => measured.get(i) ?? measureSummaryEntry(i.entry))) <=
              maxInputChars) &&
            (level > 0 || !exceedsChapterCap(distinctChapters(group), maxTokens)),
        ),
      );
      // Элемент не влез сам или уровень выше нулевого не сужается хотя бы вдвое (Р3).
      if (!spans || !levelNarrows(level, items.length, spans.length)) {
        return this.failTooLong(row, task, stage.model);
      }
      // Пересмотр Р3 (`F05 | F05-12`): уровень 0 из нескольких групп платит, только когда выше
      // него в вызов заведомо влезают два ответа группы, - иначе следующий уровень не сузится,
      // и отказ пришёл бы после оплаты всего уровня 0.
      if (
        level === 0 &&
        spans.length > 1 &&
        upperLevelBlocked(maxInputChars, emptyMergeInputChars(titles, limits), maxTokens)
      ) {
        return this.failTooLong(row, task, stage.model);
      }
      // Пробы упаковки долгие: аренду могли отдать другому, и его границы уже записаны. Без
      // аренды строки уровня не пишутся (как куски, `L-019`; Р5 `F05 | F05-Rb`).
      await ctx.renewLease();
      // Строку могли перехватить, а модель этапа - сменить: тогда у перехватчика своя упаковка.
      // Уровень пишется, только пока строка строится под операцией этой задачи; условная запись
      // берёт замок строки, а перехват меняет `operationId` той же строки - они не пересекаются
      // (решение арбитра `F05 | F05-Rb`, Р7).
      const written = await this.prisma.$transaction(async (tx) => {
        const own = await tx.bookDossier.updateMany({
          where: { id: row.id, status: 'building', operationId: task.operationId },
          data: { updatedAt: new Date() },
        });
        if (own.count === 0) return false;
        await tx.bookDossierGroup.createMany({
          data: spans.map((span, groupIndex) => ({
            dossierId: row.id,
            level,
            groupIndex,
            ...span,
          })),
          skipDuplicates: true,
        });
        return true;
      });
      // Строку перехватили: шаг этой задачи больше никому не нужен.
      return written ? { kind: 'continue' } : { kind: 'done' };
    }
    // Списки групп уровня 0 - до итогового вызова: группы проверены по своим диапазонам, а дыра
    // между ними видна только на всём плане, и отказ по ней - до оплаты итога.
    const lists = isMerge ? await this.level0Lists(row.id, partsTotal) : null;
    if (lists && missingChapters(lists, planned).length > 0) {
      await this.failBuild('bookDossier', row.id, task.operationId, row.takeovers);
      return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
    }
    const answer = await this.callShaped(
      task.operationId,
      DOSSIER_STAGE,
      summary,
      isMerge ? DOSSIER_MERGE_SHAPE : DOSSIER_SHAPE,
      ctx,
      (value) =>
        isMerge
          ? dossierMergeErrors(value, titleNumbers)
          : dossierChapterErrors(value, planned, titleNumbers),
    );
    if (!answer.ok) {
      await this.failBuild('bookDossier', row.id, task.operationId, row.takeovers);
      return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
    }
    const data = lists ? assembleDossier(answer.value as object, lists) : answer.value;
    await ctx.renewLease();
    // Строка `ready` и закрытие операции - одной записью: отказ закрытия не оставит готовое досье
    // под операцией `failed`. Строку уже перехватили - операцию закрывает перехватчик.
    await this.tasks.completeOperation(task.operationId, async (tx) => {
      await tx.bookDossier.updateMany({
        where: { id: row.id, status: 'building', operationId: task.operationId },
        data: {
          status: 'ready',
          data: data as Prisma.InputJsonValue,
          formatVersion: DOSSIER_FORMAT_VERSION,
          model: answer.model,
        },
      });
    });
    return { kind: 'done' };
  }

  /** Списки глав и разделов групп уровня 0 по порядку книги - для склейки досье (`F05-12`). */
  private async level0Lists(dossierId: string, partsTotal: number): Promise<GroupLists[]> {
    // Групп уровня 0 не больше кусков плана.
    const level0 = await this.prisma.bookDossierGroup.findMany({
      where: { dossierId, level: 0, done: true },
      select: { data: true },
      orderBy: { groupIndex: 'asc' },
      take: partsTotal,
    });
    // Данные группы записаны после проверки ответа по `DOSSIER_SHAPE`: списки в них есть.
    return level0.map((g) => g.data as unknown as GroupLists);
  }

  /** Влезет ли вход сводки досье: делитель JSON-входа, а не прозы (Р1 `F05 | F05-Rb`). */
  private summaryFit(request: ShapedRequest): Promise<{ fits: boolean; model: string }> {
    return this.llm.stageFit(DOSSIER_STAGE, request, undefined, [], SUMMARY_INPUT_CHARS_PER_TOKEN);
  }

  /**
   * Сводка не влезает и делить нечем: вызов заплатил бы и отказал. Строка `failed` сразу, без
   * перехвата; модель - чтобы ждущий не строил ту же строку той же моделью заново.
   */
  private async failTooLong(
    row: BookDossier,
    task: LlmTask,
    model: string,
  ): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(task.operationId, async (tx) => {
      await this.builder.failRow('bookDossier', row.id, task.operationId, tx, {
        failedReason: DOSSIER_TOO_LONG,
        model,
      });
    });
    return { kind: 'fail', reason: DOSSIER_TOO_LONG };
  }

  /**
   * Элементы сводки по порядку: частичные досье кусков (`itemLevel` -1) или результаты групп
   * уровня `itemLevel`. `count` не больше числа кусков плана, выборка ограничена им.
   */
  private async loadItems(
    dossierId: string,
    itemLevel: number,
    skip: number,
    count: number,
  ): Promise<GroupItem[]> {
    if (itemLevel < 0) {
      const parts = await this.prisma.bookDossierPart.findMany({
        where: { dossierId },
        select: { chapterNumber: true, partIndex: true, data: true },
        orderBy: [{ chapterNumber: 'asc' }, { partIndex: 'asc' }],
        skip,
        take: count,
      });
      return parts.map((p) => ({
        firstChapter: p.chapterNumber,
        lastChapter: p.chapterNumber,
        entry: p,
      }));
    }
    const results = await this.prisma.bookDossierGroup.findMany({
      where: { dossierId, level: itemLevel, done: true },
      select: { firstChapter: true, lastChapter: true, data: true },
      orderBy: { groupIndex: 'asc' },
      skip,
      take: count,
    });
    // Наверх результат группы уходит без списков глав и разделов: их склеивает код (`F05-12`).
    return results.map((g) => ({
      firstChapter: g.firstChapter,
      lastChapter: g.lastChapter,
      entry: { ...g, data: withoutAssembledFields(g.data as object) },
    }));
  }

  private async runGlossary(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = payloadId(task, 'glossaryId');
    const row = id
      ? await this.prisma.bookGlossary.findUnique({ where: { id }, include: { dossier: true } })
      : null;
    if (row?.status === 'ready' && row.operationId === task.operationId) {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    if (!row) {
      await this.tasks.failOperation(task.operationId);
      return { kind: 'done' };
    }
    if (row.status !== 'building' || row.operationId !== task.operationId) {
      return { kind: 'done' };
    }
    const answer = await this.callShaped(
      task.operationId,
      GLOSSARY_STAGE,
      glossaryRequest({ dossier: row.dossier.data, language: row.language }),
      GLOSSARY_SHAPE,
      ctx,
    );
    if (!answer.ok) {
      await this.failBuild('bookGlossary', row.id, task.operationId, row.takeovers);
      return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
    }
    await ctx.renewLease();
    await this.tasks.completeOperation(task.operationId, async (tx) => {
      await tx.bookGlossary.updateMany({
        where: { id: row.id, status: 'building', operationId: task.operationId },
        data: { status: 'ready', data: answer.value as Prisma.InputJsonValue, model: answer.model },
      });
    });
    return { kind: 'done' };
  }

  /**
   * Вызов с ответом по форме: не по форме или не JSON - один повтор с замечанием, затем отказ.
   * Прочие отказы модуля LLM уходят исполнителю: бюджет - пауза, остальное - `failed`.
   */
  private callShaped(
    operationId: string,
    stage: string,
    request: ShapedRequest,
    shape: Shape,
    ctx: LlmTaskContext,
    extraErrors?: (value: unknown) => string[],
  ): Promise<ShapedAnswer> {
    return callShaped(this.llm, operationId, stage, request, shape, ctx, {
      remarks: 1,
      extraErrors,
    });
  }

  /**
   * Отказ строителя не по бюджету (Р20): операция `failed`, строка ждёт одного перехвата.
   * Упал уже перехватчик - строка `failed`, её заново строит следующий, кому она нужна.
   */
  private async failBuild(
    model: 'bookDossier' | 'bookGlossary',
    rowId: string,
    operationId: string,
    takeovers: number,
  ): Promise<void> {
    await this.tasks.failOperation(operationId, async (tx) => {
      if (takeovers > 0) await this.builder.failRow(model, rowId, operationId, tx);
    });
  }

  private async onFailed(
    task: LlmTask,
    reason: string,
    model: 'bookDossier' | 'bookGlossary',
  ): Promise<void> {
    const pause = PAUSE_BY_FAILURE[reason];
    if (pause) {
      await this.tasks.pauseOperation(task.operationId, pause);
      return;
    }
    const id = payloadId(task, model === 'bookDossier' ? 'dossierId' : 'glossaryId');
    if (!id) return;
    const row =
      model === 'bookDossier'
        ? await this.prisma.bookDossier.findUnique({ where: { id } })
        : await this.prisma.bookGlossary.findUnique({ where: { id } });
    if (!row || row.operationId !== task.operationId) return;
    await this.failBuild(model, row.id, task.operationId, row.takeovers);
  }
}
