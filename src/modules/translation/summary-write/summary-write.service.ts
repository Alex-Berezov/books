import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentDraft, Language, LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { lockSummary } from '../../book-summary/book-summary-lock';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { AutostartLink, assertNoLiveRun } from '../autostart/content-autostart.start';
import { startConflict } from '../content-draft/start-conflict';
import { chapterPages } from '../chapter-pages';
import { DOSSIER_TOO_LONG } from '../dossier/dossier.constants';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  DRAFT_LIMIT_FACTOR,
  DRAFT_LIMIT_TOO_LOW,
  DRAFT_TX_OPTIONS,
} from '../content-draft/content-draft.constants';
import {
  ContentDraftService,
  contextLimits,
  DraftContext,
} from '../content-draft/content-draft.service';
import { htmlToParagraphs } from '../content-draft/content-draft.text';
import {
  acceptInTurn,
  regenFieldsOf,
  regenOperationIds,
  RegenOperationState,
  regenOperationStates,
} from '../draft-quality/run-regen';
import {
  SummaryWriteDto,
  SummaryWriteEstimateDto,
  SummaryWriteItemDto,
  SummaryWriteStateDto,
} from '../dto/summary-write-response.dto';
import { summaryHtml } from './summary-html';
import { chapterSources, writeEstimators } from './summary-estimate';
import {
  ACCEPT_ALL_CHAPTER_CHANGE,
  SUMMARY_FULL_UNFINISHED,
  SUMMARY_ITEM_NOT_PROPOSED,
  SUMMARY_ITEM_UNKNOWN,
  SUMMARY_REGEN_IN_PROGRESS,
  SUMMARY_SECTIONS_UNFINISHED,
  SUMMARY_WRITE_NOT_READY,
} from './summary-write.constants';
import {
  emptyWriteData,
  fieldPrint,
  hasText,
  readWriteData,
  SummaryWriteData,
  toJson,
  withItem,
  WriteItem,
} from './summary-write.data';
import { savedFull, sectionChapters } from './summary-sources';
import { readyGate, SummaryWriteFields } from './summary-write.fields';
import { summaryWriteTaskInput, SummaryWriteHandler } from './summary-write.handler';
import {
  briefPart,
  fullPart,
  NO_QUOTES,
  PartContext,
  partUsd,
  pipelineUsd,
  runPlanOf,
  sectionPart,
  sectionSource,
  SectionSource,
  tailUsd,
} from './summary-write.parts';

const KIND = 'summary_write' as const;

/** Порядок «Accept all»: разделы по номеру, затем полный и «Очень кратко» (`tech.md` §5). */
const TARGET_ORDER = { section: 0, full: 1, brief: 2 } as const;

interface Estimate {
  dto: SummaryWriteEstimateDto;
  suggestedLimitUsd: Prisma.Decimal;
  contextLimitUsd: Prisma.Decimal;
  context: DraftContext;
  language: Language;
}

/**
 * Ход пересказа «Write Summary» (`F06-2`; `features/F06-summary-autofill/tech.md` §4-§6): оценка
 * конвейера, старт с правом хода на поля под замком пересказа, ход, перегенерация текста своей
 * операцией, «Accept» и «Discard» предложений, отмена хода. Контекст досье и глоссария и отказы
 * старта (`DOSSIER_STALE`, потолок, лимит) - те же, что у заготовок `F05-10` (`draftContext`).
 */
@Injectable()
export class SummaryWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly drafts: ContentDraftService,
    private readonly fields: SummaryWriteFields,
    private readonly handler: SummaryWriteHandler,
  ) {}

  async estimate(versionId: string): Promise<SummaryWriteEstimateDto> {
    return (await this.estimateOf(versionId)).dto;
  }

  /**
   * Ручной старт (`tech.md` §6): прежний готовый или упавший ход отбрасывается вместе с операциями
   * его перегенераций; право хода на поля - под замком пересказа в одной транзакции со строкой (§5).
   *
   * Автозапуск (`autostart`, `F06-5`): прежние не отбрасываются; неотброшенный ход вида под замком -
   * 409 `AUTOSTART_SKIPPED_EXISTING` (`ready`) или `AUTOSTART_SKIPPED_IN_PROGRESS` (`building`),
   * второй автозапуск того же языка - 409 `AUTOSTART_DUPLICATE` уникальным индексом (`L-019`).
   */
  async start(
    versionId: string,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string | null,
    autostart: AutostartLink | null = null,
  ): Promise<SummaryWriteDto> {
    // Живой ход вида главнее отказов старта (`tech.md` §4 п.4, Р9): иначе потолок или устаревшее
    // досье завели бы строку `failed` рядом с `ready`. Чтение до отказов выбирает исход, под замком
    // транзакции та же проверка повторяется (L-019).
    if (autostart) await assertNoLiveRun(this.prisma, versionId, KIND);
    this.llm.assertEnabled();
    const estimate = await this.estimateOf(versionId);
    if (estimate.dto.dossier?.refusedTooLong) {
      throw llmTaskConflict(
        DOSSIER_TOO_LONG,
        'The dossier summary is too long for the stage model',
      );
    }
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const limit = limitUsd ?? estimate.suggestedLimitUsd;
    if (limit.lt(estimate.contextLimitUsd)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `limitUsd must fit the dossier and glossary built first: at least ${moneyUsd(estimate.contextLimitUsd)}`,
        code: DRAFT_LIMIT_TOO_LOW,
      });
    }
    const opData = await this.llm.operationData({
      kind: 'draft',
      bookVersionId: versionId,
      limitUsd: limit,
      createdById,
      translationRunId: autostart?.translationRunId ?? null,
      contentKind: KIND,
    });
    let id: string;
    let stale: string[] = [];
    try {
      id = await this.prisma.$transaction(async (tx) => {
        await lockSummary(tx, versionId);
        if (autostart) {
          await assertNoLiveRun(tx, versionId, KIND);
        } else {
          const previous = await tx.contentDraft.findMany({
            where: { bookVersionId: versionId, kind: KIND, status: { in: ['ready', 'failed'] } },
            select: { id: true, data: true },
            take: 100,
          });
          await tx.contentDraft.updateMany({
            where: { id: { in: previous.map((p) => p.id) } },
            data: { status: 'discarded' },
          });
          stale = previous.flatMap((p) => regenOperations(p.data));
        }
        const data = emptyWriteData(...(await this.ownership(tx, versionId)));
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.contentDraft.create({
          data: {
            bookVersionId: versionId,
            kind: KIND,
            language: estimate.language,
            operationId: op.id,
            dossierId: estimate.context.run?.dossierId ?? null,
            glossaryId: estimate.context.run?.glossaryId ?? null,
            translationRunLanguageId: autostart?.translationRunLanguageId ?? null,
            data: toJson(data),
          },
        });
        await this.tasks.enqueue(summaryWriteTaskInput(row, op.id), tx);
        return row.id;
      }, DRAFT_TX_OPTIONS);
    } catch (error) {
      throw startConflict(error, autostart !== null, KIND);
    }
    // Перегенерации отброшенных ходов - после коммита нового хода: старт не удался - их оплаченная
    // работа не снята. Обрыв здесь оставляет операцию, которая сама кончится на условии строки
    // (ход уже не `ready`) или снимается со страницы операций.
    await this.cancelRegens(stale);
    return this.get(id);
  }

  async latest(versionId: string): Promise<SummaryWriteStateDto> {
    const row = await this.prisma.contentDraft.findFirst({
      where: { bookVersionId: versionId, kind: KIND, status: { not: 'discarded' } },
      include: { operation: true },
      orderBy: { createdAt: 'desc' },
    });
    return { draft: row ? await this.toDto(row) : null };
  }

  async get(id: string): Promise<SummaryWriteDto> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!row || row.kind !== KIND) throw new NotFoundException('Summary run not found');
    return this.toDto(row);
  }

  /** Отмена хода (как «Discard draft» `F05-10`): строящийся - с его операцией; перегенерации - всегда. */
  async discard(id: string): Promise<SummaryWriteDto> {
    const row = await this.row(id);
    // Сначала перегенерации (каждая со снятием своей отметки), потом сам ход: обрыв посреди не
    // оставляет операции перегенерации у отброшенного хода.
    await this.cancelRegens(regenOperations(row.data));
    if (row.status === 'building') {
      await this.tasks.cancelOperation(row.operationId, async (tx) => {
        await tx.contentDraft.updateMany({
          where: { id, status: 'building' },
          data: { status: 'discarded' },
        });
      });
    }
    await this.prisma.contentDraft.updateMany({
      where: { id, status: { not: 'discarded' } },
      data: { status: 'discarded' },
    });
    return this.get(id);
  }

  private async cancelRegens(operationIds: readonly string[]): Promise<void> {
    for (const operationId of operationIds) {
      await this.tasks.cancelOperation(operationId, (tx) =>
        this.handler.clearRegenMark(operationId, tx),
      );
    }
  }

  /**
   * «Regenerate» текста хода `ready` (`tech.md` §4): своя операция и задача, замечание редактора
   * в промпт автора, свежий снимок моделей (Р5). Вторая перегенерация того же текста до конца
   * первой - 409.
   */
  async regenerate(
    id: string,
    index: number,
    remark: string | null,
    createdById: string,
  ): Promise<SummaryWriteDto> {
    const row = await this.row(id);
    const data = readWriteData(row.data);
    const item = this.itemOf(row, data, index);
    if (item.regen) {
      throw llmTaskConflict(SUMMARY_REGEN_IN_PROGRESS, 'This text is being regenerated');
    }
    this.llm.assertEnabled();
    const usd = await this.regenUsd(row, data, item, remark);
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const opData = await this.llm.operationData({
      kind: 'draft',
      bookVersionId: row.bookVersionId,
      limitUsd: usd.mul(DRAFT_LIMIT_FACTOR),
      createdById,
      contentKind: KIND,
    });
    await this.prisma.$transaction(async (tx) => {
      await lockSummary(tx, row.bookVersionId);
      const current = await tx.contentDraft.findUnique({ where: { id } });
      const fresh = current ? readWriteData(current.data) : null;
      if (!current || current.status !== 'ready' || !fresh?.items[index]) {
        throw llmTaskConflict(SUMMARY_WRITE_NOT_READY, 'The summary run is not ready');
      }
      if (fresh.items[index].regen) {
        throw llmTaskConflict(SUMMARY_REGEN_IN_PROGRESS, 'This text is being regenerated');
      }
      // Лимит посчитан по снимку до транзакции: текст за это время получил или потерял текст -
      // достройка и лимит разошлись бы (решение арбитра, круг 3), повторить «Regenerate».
      if (hasText(fresh.items[index]) !== hasText(item)) {
        throw llmTaskConflict(
          SUMMARY_WRITE_NOT_READY,
          'The text changed meanwhile: regenerate again',
        );
      }
      const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
      const next = withItem(fresh, index, {
        regen: {
          operationId: op.id,
          remark,
          pending: null,
          produced: false,
          // Достройка полного и «Очень кратко» - только у раздела без текста (`tech.md` §4, оценка).
          tail: item.target === 'section' && !hasText(item),
          tailDone: [],
        },
      });
      await tx.contentDraft.update({ where: { id }, data: { data: toJson(next) } });
      await this.tasks.enqueue(summaryWriteTaskInput(current, op.id, index), tx);
    }, DRAFT_TX_OPTIONS);
    return this.get(id);
  }

  /** «Accept» предложения: в поле, если поле не меняли после предложения (`tech.md` §5). */
  async accept(id: string, index: number, confirmChapterChange: boolean): Promise<SummaryWriteDto> {
    const row = await this.row(id);
    const item = this.itemOf(row, readWriteData(row.data), index);
    if (item.regen) {
      throw llmTaskConflict(SUMMARY_REGEN_IN_PROGRESS, 'This text is being regenerated');
    }
    // Ждущий раздел (Р1) сначала решается: записан прямо - «Accept» исполнен; ждёт дальше - 409
    // с причиной, а не «не предложение».
    if (item.outcome === 'waiting') {
      const outcome = await this.fields.settle(row, readyGate, index);
      if (outcome === 'written') return this.get(id);
      if (outcome === 'waiting') {
        throw llmTaskConflict(
          SUMMARY_ITEM_NOT_PROPOSED,
          `Section ${item.number} waits for the section before it to get a text`,
        );
      }
    }
    await this.fields.accept(row, index, confirmChapterChange);
    return this.get(id);
  }

  /**
   * «Accept all» (`tech.md` §5): те же правила по одному, разделы по возрастанию номера; на версии
   * с иным делением глав - 409 `ACCEPT_ALL_CHAPTER_CHANGE` до первой записи.
   */
  async acceptAll(id: string): Promise<SummaryWriteDto> {
    const row = await this.row(id);
    if (row.status !== 'ready') {
      throw llmTaskConflict(SUMMARY_WRITE_NOT_READY, 'The summary run is not ready');
    }
    for (const [i, item] of readWriteData(row.data).items.entries()) {
      if (item.outcome === 'waiting') await this.fields.settle(row, readyGate, i);
    }
    const data = readWriteData((await this.row(id)).data);
    const changes = await this.fields.chapterChanges(row, data);
    if (changes.length > 0) {
      throw llmTaskConflict(
        ACCEPT_ALL_CHAPTER_CHANGE,
        `Sections ${changes.join(', ')} move to other reader chapters: accept them one by one`,
      );
    }
    const order = data.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.outcome === 'proposed' && !item.regen)
      .sort(
        (a, b) =>
          TARGET_ORDER[a.item.target] - TARGET_ORDER[b.item.target] ||
          (a.item.number ?? 0) - (b.item.number ?? 0),
      );
    // По одному (`tech.md` §5): отказ - с тем, что уже записано (ревью `F06-3`, перенесено в `F06-5`).
    await acceptInTurn(
      (accepted) => order[accepted.length]?.index ?? null,
      (index) => this.fields.accept(row, index, false),
    );
    return this.get(id);
  }

  /** «Discard» предложения или ждущего раздела: поле не трогается. */
  async discardItem(id: string, index: number): Promise<SummaryWriteDto> {
    const row = await this.row(id);
    this.itemOf(row, readWriteData(row.data), index);
    const changed = await this.fields.mutate(row, readyGate, (data) => {
      const item = data.items[index];
      // Идёт перегенерация - её итог вернул бы предложение после «Discard» (как у «Accept»).
      if (item?.regen) {
        throw llmTaskConflict(SUMMARY_REGEN_IN_PROGRESS, 'This text is being regenerated');
      }
      if (!item || (item.outcome !== 'proposed' && item.outcome !== 'waiting')) return null;
      return withItem(data, index, { outcome: 'discarded' });
    });
    if (changed?.items[index]?.outcome !== 'discarded') {
      throw llmTaskConflict(SUMMARY_ITEM_NOT_PROPOSED, 'The text is not a proposal');
    }
    return this.get(id);
  }

  // -------------------------------------------------------------------------

  /** Право хода на поля на старте (§5): версия не опубликована и поле пусто; отпечаток поля. */
  private async ownership(
    tx: Prisma.TransactionClient,
    versionId: string,
  ): Promise<Parameters<typeof emptyWriteData>> {
    const state = await this.fields.state(tx, versionId);
    const open = !state.published;
    return [
      {
        sections: open && state.sections.length === 0,
        full: open && !state.hasText,
        brief: open && !state.briefHasText,
      },
      { full: fieldPrint(state.summary), brief: fieldPrint(state.brief), sections: {} },
    ];
  }

  private async row(id: string): Promise<ContentDraft> {
    const row = await this.prisma.contentDraft.findUnique({ where: { id } });
    if (!row || row.kind !== KIND) throw new NotFoundException('Summary run not found');
    return row;
  }

  private itemOf(row: ContentDraft, data: SummaryWriteData, index: number): WriteItem {
    if (row.status !== 'ready') {
      throw llmTaskConflict(SUMMARY_WRITE_NOT_READY, 'The summary run is not ready');
    }
    const item = data.items[index];
    // Заглушка элемента не той формы (`brokenItem`) - не текст хода: ручки его не трогают.
    if (!item || 'broken' in item) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `The summary run has no text ${index}`,
        code: SUMMARY_ITEM_UNKNOWN,
      });
    }
    return item;
  }

  /**
   * Оценка конвейера (`tech.md` §6-§7): план досье известен - по разделу плана на главах версии;
   * досье ещё нет - сверху, по главе на раздел. Версия без текста глав - отказ до досье (§8 п.11).
   */
  private async estimateOf(versionId: string): Promise<Estimate> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    if (!(await this.hasChapterText(versionId))) {
      throw llmTaskConflict('SOURCE_HAS_NO_CHAPTERS', 'The version has no chapter text');
    }
    const calls = await writeEstimators(this.llm);
    const context = await this.drafts.draftContext(versionId, version);
    const partContext: PartContext = {
      language: version.language,
      dossier: context.dossier?.data ?? null,
      glossary: context.glossaryData,
    };
    const plan = context.dossier ? runPlanOf(context.dossier.data) : [];
    const upperBound = plan.length === 0;
    const sources: SectionSource[] = [];
    if (upperBound) {
      sources.push(...(await chapterSources(this.prisma, versionId, version.language)));
    } else {
      for (const section of plan) {
        const chapters = await sectionChapters(this.prisma, versionId, section);
        sources.push(sectionSource(section, chapters, version.language));
      }
    }
    const extra =
      upperBound || context.glossaryLine !== null ? await contextUpperChars(this.llm) : 0;
    const usd = pipelineUsd(calls, partContext, sources, extra);
    const lines = contextLimits(context, usd);
    return {
      suggestedLimitUsd: lines.suggestedLimitUsd,
      contextLimitUsd: lines.contextLimitUsd,
      context,
      language: version.language,
      dto: {
        dossier: lines.dossier,
        glossary: lines.glossary,
        sections: upperBound ? null : plan.length,
        stageUsd: moneyUsd(usd),
        upperBound,
        suggestedLimitUsd: moneyUsd(lines.suggestedLimitUsd),
      },
    };
  }

  /**
   * Оценка перегенерации (`tech.md` §4): текст × 2 прохода; у раздела без текста - плюс полный и
   * «Очень кратко». Полному нужен текст у каждого раздела плана, «Очень кратко» - полный (409).
   */
  private async regenUsd(
    row: ContentDraft,
    data: SummaryWriteData,
    item: WriteItem,
    remark: string | null,
  ): Promise<Prisma.Decimal> {
    const calls = await writeEstimators(this.llm);
    const dossier = row.dossierId
      ? await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } })
      : null;
    const plan = dossier ? runPlanOf(dossier.data) : [];
    const glossary = row.glossaryId
      ? await this.prisma.bookGlossary.findUnique({
          where: { id: row.glossaryId },
          select: { data: true },
        })
      : null;
    const context: PartContext = {
      language: row.language,
      dossier: dossier?.data ?? null,
      glossary: glossary?.data ?? null,
    };
    if (item.target === 'section') {
      const section = plan.find((p) => p.number === item.number);
      if (!section) throw llmTaskConflict(SUMMARY_WRITE_NOT_READY, 'The plan has no such section');
      const chapters = await sectionChapters(this.prisma, row.bookVersionId, section);
      const usd = partUsd(
        calls,
        sectionPart(context, sectionSource(section, chapters, row.language), remark),
        0,
      );
      return hasText(item) ? usd : usd.add(tailUsd(calls, context, plan.length));
    }
    if (item.target === 'full') {
      if ((await this.handler.sectionTexts(row, data, plan)) === null) {
        throw llmTaskConflict(
          SUMMARY_SECTIONS_UNFINISHED,
          'Not every section of the plan has a text',
        );
      }
      return partUsd(
        calls,
        fullPart(context, [], NO_QUOTES, remark),
        plan.length * calls.section.maxTokens,
      );
    }
    const full = data.items.find((i) => i.target === 'full');
    const saved = await savedFull(this.prisma, row.bookVersionId);
    if (saved === null && !(full && hasText(full))) {
      throw llmTaskConflict(SUMMARY_FULL_UNFINISHED, 'There is no full summary with a text');
    }
    return partUsd(calls, briefPart(context, '', NO_QUOTES, remark), calls.full.maxTokens);
  }

  private async hasChapterText(versionId: string): Promise<boolean> {
    for await (const page of chapterPages(this.prisma, versionId, {
      number: true,
      content: true,
    })) {
      if (page.some((c) => htmlToParagraphs(c.content) !== '')) return true;
    }
    return false;
  }

  private async toDto(row: ContentDraft & { operation: LlmOperation }): Promise<SummaryWriteDto> {
    const data = readWriteData(row.data);
    let waitingFor: SummaryWriteDto['waitingFor'] = null;
    if (row.waitingFor && row.status === 'building') {
      const glossary = await this.prisma.bookGlossary.findUnique({
        where: { id: row.waitingFor },
        select: { id: true },
      });
      waitingFor = glossary ? 'glossary' : 'dossier';
    }
    // Статус и причина паузы перегенераций (F06-5c): одним запросом по идущим операциям.
    const regenOps = await regenOperationStates(this.prisma, regenOperations(row.data));
    return {
      id: row.id,
      bookVersionId: row.bookVersionId,
      status: row.status,
      language: row.language,
      failedReason: row.failedReason,
      waitingFor,
      operation: toOperationDto(row.operation),
      plannedSections: data.plannedSections,
      // Разделы с текстом: «не удалось» в счёт «Writing: sections N of M» не идёт.
      sectionsDone: data.items.filter((i) => i.target === 'section' && hasText(i)).length,
      owns: data.owns,
      items: data.items.map((item, index) => itemDto(item, index, regenOps)),
      chapterChanges: row.status === 'ready' ? await this.fields.chapterChanges(row, data) : [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Операции перегенераций, идущих у текстов хода. */
const regenOperations = (data: unknown): string[] => regenOperationIds(readWriteData(data).items);

function itemDto(
  item: WriteItem,
  index: number,
  regenOps: ReadonlyMap<string, RegenOperationState>,
): SummaryWriteItemDto {
  return {
    index,
    target: item.target,
    number: item.number,
    title: item.title,
    readerChapter: item.readerChapter,
    html: item.verdict === 'failed' ? '' : summaryHtml(item.text),
    attempt: item.attempt,
    verdict: item.verdict,
    remarks: item.remarks,
    review: item.review
      ? {
          kind: item.review.kind,
          model: item.review.kind === 'answered' ? item.review.model : null,
        }
      : null,
    outcome: item.outcome,
    failedReason: item.failedReason,
    authorModel: item.authorModel,
    regenFailedReason: item.regenFailedReason,
    ...regenFieldsOf(item.regen, regenOps),
  };
}
