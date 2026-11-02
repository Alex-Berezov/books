import { Injectable } from '@nestjs/common';
import { ContentDraft, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { lockSummary } from '../../book-summary/book-summary-lock';
import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import { LlmService } from '../../llm/llm.service';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { chapterPages } from '../chapter-pages';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { runQualityLoop } from '../draft-quality/quality-loop';
import { ChapterIndex, indexChapters } from '../draft-quality/quote-check';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import { runStageModels } from '../run/run-models';
import {
  DRAFT_INPUT_MISSING,
  DRAFT_INVALID_RESPONSE,
  DRAFT_NO_PLAN,
  DRAFT_TOO_LONG,
} from '../content-draft/content-draft.constants';
import { ContentDraftService, hasVisibleText } from '../content-draft/content-draft.service';
import { htmlToParagraphs } from '../content-draft/content-draft.text';
import { awaitDraftContext } from '../content-draft/draft-context-wait';
import { SummaryTarget } from './summary-checks';
import { summaryHtml } from './summary-html';
import { SUMMARY_REVIEW_STAGE, SUMMARY_WRITE_TASK_KIND } from './summary-write.constants';
import {
  hasText,
  partKey,
  PendingText,
  readWriteData,
  sectionItems,
  SummaryWriteData,
  toJson,
  withItem,
  WriteItem,
} from './summary-write.data';
import { DraftGate, regenGate, runGate, SummaryWriteFields } from './summary-write.fields';
import {
  AUTHOR_STAGE,
  briefPart,
  fullPart,
  loopSpec,
  PartContext,
  PartInput,
  RunPlanSection,
  runPlanOf,
  SectionText,
  sectionPart,
  sectionSource,
} from './summary-write.parts';

/** Задача хода (`index` нет) или перегенерации текста `index` (`tech.md` §4, Р2). */
export function summaryWriteTaskInput(
  row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
  operationId: string,
  index: number | null = null,
): EnqueueTaskInput {
  return {
    kind: SUMMARY_WRITE_TASK_KIND,
    operationId,
    bookVersionId: row.bookVersionId,
    language: row.language,
    payload: index === null ? { draftId: row.id } : { draftId: row.id, index },
    pairKey: index === null ? `${operationId}:${row.id}` : `${operationId}:${row.id}:${index}`,
  };
}

function payloadOf(task: LlmTask): { draftId: string | null; index: number | null } {
  const p = (task.payload ?? {}) as Record<string, unknown>;
  return {
    draftId: typeof p.draftId === 'string' ? p.draftId : null,
    index: Number.isInteger(p.index) ? (p.index as number) : null,
  };
}

/** Запрос `data @>`: строка хода, у текста которой идёт перегенерация операцией `operationId` (Р2). */
const regenProbe = (operationId: string): string =>
  JSON.stringify({ items: [{ regen: { operationId } }] });

/** Как сохраняется оплаченный текст до итога части: ход - в данных хода, перегенерация - в своём тексте. */
type PendingSlot = {
  read: (data: SummaryWriteData) => PendingText | null;
  write: (data: SummaryWriteData, pending: PendingText | null) => SummaryWriteData;
};

const runSlot: PendingSlot = {
  read: (data) => data.pending,
  write: (data, pending) => ({ ...data, pending }),
};

const regenSlot = (index: number): PendingSlot => ({
  read: (data) => data.items[index]?.regen?.pending ?? null,
  write: (data, pending) => {
    const regen = data.items[index]?.regen;
    return regen ? withItem(data, index, { regen: { ...regen, pending } }) : data;
  },
});

/**
 * Шаги хода пересказа (`F06-2`; `features/F06-summary-autofill/tech.md` §4-§5). Одна задача - один
 * шаг, продолжение - следующей задачей: разделы плана досье по порядку → полный → «Очень кратко»,
 * каждый текст - циклом качества, запись в поля после каждой части (обрыв не теряет готового).
 * Полный строится, только когда текст есть у каждого раздела плана (`product.md` §3). Пауза
 * операции (потолок, лимит, деньги) ход не меняет; «Continue» продолжает с сохранённого (Р3).
 *
 * Перегенерация текста хода `ready` - своя операция и задача с `index` (Р2, Р5): условие записи -
 * её операция у этого текста; первый текст раздела достраивает полный и «Очень кратко».
 */
@Injectable()
export class SummaryWriteHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierDemandService,
    private readonly drafts: ContentDraftService,
    private readonly fields: SummaryWriteFields,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  /**
   * «Continue» операции перегенерации (Р2): её строку `findUnique` по `operationId` не находит -
   * строка ищется по `data @> regen.operationId`; задача - только пока перегенерация её.
   */
  async regenResume(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ContentDraft"
      WHERE "kind" = 'summary_write' AND "status" = 'ready'
        AND "data" @> ${regenProbe(op.id)}::jsonb
      LIMIT 1`;
    if (rows.length === 0) return [];
    const row = await this.prisma.contentDraft.findUnique({ where: { id: rows[0].id } });
    if (!row) return [];
    const index = readWriteData(row.data).items.findIndex((i) => i.regen?.operationId === op.id);
    return index < 0 ? [] : [summaryWriteTaskInput(row, op.id, index)];
  }

  /** Отмена операции перегенерации: снимается отметка у её текста, ход остаётся `ready` (Р2). */
  onRegenCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    return this.clearRegenMark(op.id, tx);
  }

  /** Отметка перегенерации `operationId` снимается у её текста в транзакции отмены. */
  async clearRegenMark(operationId: string, tx: Prisma.TransactionClient): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string; bookVersionId: string }>>`
      SELECT "id", "bookVersionId" FROM "ContentDraft"
      WHERE "kind" = 'summary_write' AND "data" @> ${regenProbe(operationId)}::jsonb
      LIMIT 1`;
    if (rows.length === 0) return;
    await lockSummary(tx, rows[0].bookVersionId);
    const row = await tx.contentDraft.findUnique({ where: { id: rows[0].id } });
    if (!row) return;
    const data = readWriteData(row.data);
    const index = data.items.findIndex((i) => i.regen?.operationId === operationId);
    if (index < 0) return;
    await tx.contentDraft.update({
      where: { id: row.id },
      data: { data: toJson(withItem(data, index, { regen: null })) },
    });
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const { draftId, index } = payloadOf(task);
    const row = draftId
      ? await this.prisma.contentDraft.findUnique({ where: { id: draftId } })
      : null;
    if (!row || row.kind !== 'summary_write') {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    return index === null ? this.runStep(row, task, ctx) : this.regenStep(row, index, task, ctx);
  }

  private async runStep(
    row: ContentDraft,
    task: LlmTask,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    // Ход отбросили, он кончился или задача не его операции: делать нечего.
    if (row.status !== 'building' || row.operationId !== task.operationId) {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    if (!row.dossierId) {
      return awaitDraftContext(
        {
          db: this.prisma,
          tasks: this.tasks,
          dossiers: this.dossiers,
          languageOf: (id) => this.drafts.languageOf(id),
        },
        row,
      );
    }
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } });
    if (!dossier) return this.fail(row, DRAFT_INPUT_MISSING);
    const plan = runPlanOf(dossier.data);
    if (plan.length === 0) return this.fail(row, DRAFT_NO_PLAN);
    const gate = runGate(row.operationId);
    const data = await this.fields.mutate(row, gate, (d) =>
      d.plannedSections === plan.length ? null : { ...d, plannedSections: plan.length },
    );
    // Строки нет или она уже не этой операции: операция закрывается, а не висит `active` (круг 5).
    if (!data) return this.stepGone(row.operationId);
    // Текст, записанный в данные, но не дошедший до поля (обрыв между записями): дописать.
    for (const [i, item] of data.items.entries()) {
      if (item.outcome === 'waiting') await this.fields.settle(row, gate, i);
    }
    const context = await this.contextOf(row, dossier.data);
    const step = await this.nextPart(row, data, plan, context, null);
    if (step === null) return this.finish(row);
    return this.producePart(row, gate, runSlot, step, row.operationId, ctx, {
      replaceAt: null,
      regenIndex: null,
    });
  }

  /** Перегенерация текста `index`: сам текст, затем при первом тексте раздела - полный и «Очень кратко». */
  private async regenStep(
    row: ContentDraft,
    index: number,
    task: LlmTask,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const gate = regenGate(task.operationId, index);
    const data = readWriteData(row.data);
    const item = data.items[index];
    if (!item?.regen || !gate.allows(row, data) || !row.dossierId) {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } });
    const plan = dossier ? runPlanOf(dossier.data) : [];
    const context = await this.contextOf(row, dossier?.data ?? null);
    if (!item.regen.produced) {
      const part = await this.partFor(row, data, plan, context, item, item.regen.remark);
      if (part === null) return this.finishRegen(task.operationId);
      return this.producePart(row, gate, regenSlot(index), { index, part }, task.operationId, ctx, {
        replaceAt: index,
        regenIndex: index,
      });
    }
    // Достройка (`tech.md` §4): у раздела раньше текста не было - полный и «Очень кратко» тем же
    // ходом; часть, которую достройка уже пробовала, не повторяется.
    const tail =
      item.target === 'section' && item.regen.tail
        ? await this.nextPart(row, data, plan, context, item.regen.tailDone)
        : null;
    if (tail === null) return this.finishRegen(task.operationId);
    return this.producePart(row, gate, regenSlot(index), tail, task.operationId, ctx, {
      replaceAt: null,
      regenIndex: index,
    });
  }

  /**
   * Следующая часть хода: раздел плана без текста хода, затем полный и «Очень кратко». `tried` -
   * достройка перегенерацией: только полный и «Очень кратко», если их нет или они не удались, и
   * только те, что эта достройка ещё не пробовала (повтора без предела нет).
   */
  private async nextPart(
    row: ContentDraft,
    data: SummaryWriteData,
    plan: RunPlanSection[],
    context: PartContext,
    tried: ReadonlyArray<'full' | 'brief'> | null,
  ): Promise<{ index: number; part: PartInput | FailedPart } | null> {
    const sections = sectionItems(data);
    if (tried === null && sections.length < plan.length) {
      const section = plan[sections.length];
      const chapters = await this.drafts.sectionChapters(row.bookVersionId, section);
      const source = sectionSource(section, chapters, row.language);
      if (source.chapters.length === 0) {
        return {
          index: data.items.length,
          part: { failed: DRAFT_INPUT_MISSING, target: 'section', source },
        };
      }
      return { index: data.items.length, part: sectionPart(context, source, null) };
    }
    const sectionTexts = await this.sectionTexts(row, data, plan);
    // Полный - только когда текст есть у каждого раздела плана (`product.md` §3).
    if (sectionTexts === null) return null;
    const fullAt = data.items.findIndex((i) => i.target === 'full');
    const full = fullAt < 0 ? null : data.items[fullAt];
    if (!full || !hasText(full)) {
      // Свой полный хода уже не удался - ход его не повторяет; повтор - «Regenerate». Достройка
      // пробует его один раз.
      if ((tried === null && full) || tried?.includes('full')) return null;
      const quotes = await this.quoteIndex(row.bookVersionId);
      return {
        index: fullAt < 0 ? data.items.length : fullAt,
        part: fullPart(context, sectionTexts, quotes, null),
      };
    }
    const briefAt = data.items.findIndex((i) => i.target === 'brief');
    const brief = briefAt < 0 ? null : data.items[briefAt];
    if (brief && (hasText(brief) || tried === null)) return null;
    if (tried?.includes('brief')) return null;
    // «Очень кратко» хода - по полному этого хода, проверенному моделью (решение арбитра, круг 2);
    // сохранённый полный редактора - только у «Regenerate» «Очень кратко» (`partFor`).
    const fullText = full.text;
    const quotes = await this.quoteIndex(row.bookVersionId);
    return {
      index: briefAt < 0 ? data.items.length : briefAt,
      part: briefPart(context, fullText, quotes, null),
    };
  }

  /** Вход перегенерации текста: тот же, что у хода, плюс замечание редактора. */
  private async partFor(
    row: ContentDraft,
    data: SummaryWriteData,
    plan: RunPlanSection[],
    context: PartContext,
    item: WriteItem,
    remark: string | null,
  ): Promise<PartInput | FailedPart | null> {
    if (item.target === 'section') {
      const section = plan.find((p) => p.number === item.number);
      if (!section) return null;
      const chapters = await this.drafts.sectionChapters(row.bookVersionId, section);
      const source = sectionSource(section, chapters, row.language);
      if (source.chapters.length === 0)
        return { failed: DRAFT_INPUT_MISSING, target: 'section', source };
      return sectionPart(context, source, remark);
    }
    const sections = await this.sectionTexts(row, data, plan);
    if (item.target === 'full') {
      if (sections === null) return null;
      return fullPart(context, sections, await this.quoteIndex(row.bookVersionId), remark);
    }
    const fullItem = data.items.find((i) => i.target === 'full');
    const fullText =
      (await this.drafts.savedFull(row.bookVersionId)) ??
      (fullItem && hasText(fullItem) ? fullItem.text : null);
    if (fullText === null) return null;
    return briefPart(context, fullText, await this.quoteIndex(row.bookVersionId), remark);
  }

  /**
   * Тексты разделов для полного (`tech.md` §4 шаг 2): раздел, сохранённый редактором с текстом, -
   * его текст (полный строится из правки, `product.md` §5), иначе текст хода. Нет текста хотя бы
   * у одного раздела плана - `null`.
   */
  async sectionTexts(
    row: ContentDraft,
    data: SummaryWriteData,
    plan: RunPlanSection[],
  ): Promise<SectionText[] | null> {
    const saved = await this.prisma.bookSummarySection.findMany({
      where: { bookVersionId: row.bookVersionId },
      select: { number: true, title: true, text: true },
      orderBy: { number: 'asc' },
      take: SUMMARY_SECTION_LIMITS.sectionsPerVersion,
    });
    const items = sectionItems(data);
    const texts: SectionText[] = [];
    for (const section of plan) {
      const own = saved.find((s) => s.number === section.number);
      const ownText = own ? htmlToParagraphs(own.text) : '';
      const item = items.find((i) => i.number === section.number);
      if (own && ownText !== '') {
        texts.push({ label: `section ${section.number}`, title: own.title, text: ownText });
      } else if (item && hasText(item)) {
        texts.push({
          label: `section ${section.number}`,
          title: item.title ?? '',
          text: item.text,
        });
      } else {
        return null;
      }
    }
    return texts;
  }

  /**
   * Одна часть: цикл качества (оплаченный текст сохраняется до проверяющей и до переделки, Р3),
   * текст в данные хода, затем в поле или в предложение (`tech.md` §5). Место полного и «Очень
   * кратко» находится под замком при записи, а не по снимку шага: две достройки не пишут в одно
   * место. Неудачная перегенерация прежний текст не стирает - пишет только причину.
   */
  private async producePart(
    row: ContentDraft,
    gate: DraftGate,
    slot: PendingSlot,
    step: { index: number; part: PartInput | FailedPart },
    operationId: string,
    ctx: LlmTaskContext,
    opts: { replaceAt: number | null; regenIndex: number | null },
  ): Promise<LlmTaskStepResult> {
    const { part } = step;
    const item =
      'failed' in part
        ? failedItem(part)
        : await this.loop(row, gate, slot, part, operationId, ctx);
    // Строка больше не принимает шаг этой операции (отброшена, перегенерацию сняли): операция
    // закрывается, а не остаётся `active` без задач (круг 4).
    if (item === null) return this.stepGone(operationId);
    await ctx.renewLease();
    let at = opts.replaceAt ?? step.index;
    let settle = item.verdict !== 'failed';
    const tailPart = opts.replaceAt === null && part.target !== 'section';
    const saved = await this.fields.mutate(row, gate, (data) => {
      const items = [...data.items];
      if (tailPart) {
        const existing = items.findIndex((i) => i.target === part.target);
        at = existing < 0 ? items.length : existing;
      }
      const current = items[at];
      const keepsText = current !== undefined && hasText(current);
      if (tailPart && keepsText) {
        // Часть с текстом уже написала другая достройка: свой ответ поверх не пишется.
        settle = false;
      } else if (opts.replaceAt !== null && current?.regen) {
        const regen = { ...current.regen, pending: null, produced: true };
        const failedAgain = item.verdict === 'failed' && keepsText;
        items[at] = failedAgain
          ? { ...current, regen, regenFailedReason: item.failedReason }
          : { ...item, regen, regenFailedReason: null };
        if (failedAgain) settle = false;
      } else {
        items[at] = item;
      }
      let next = slot.write({ ...data, items }, null);
      // Достройка отмечает испробованную часть у текста перегенерации: повтора без предела нет.
      const regenAt = opts.regenIndex;
      const regen = regenAt === null ? null : next.items[regenAt]?.regen;
      if (tailPart && regenAt !== null && regen) {
        next = withItem(next, regenAt, {
          regen: { ...regen, tailDone: [...regen.tailDone, tailTarget(part.target)] },
        });
      }
      return next;
    });
    if (!saved) return this.stepGone(operationId);
    if (settle) await this.fields.settle(row, gate, at);
    return { kind: 'continue' };
  }

  /** Цикл качества части; обрыв от модуля LLM (деньги, лимит) уходит исполнителю - пауза. */
  private async loop(
    row: ContentDraft,
    gate: DraftGate,
    slot: PendingSlot,
    part: PartInput,
    operationId: string,
    ctx: LlmTaskContext,
  ): Promise<WriteItem | null> {
    const base = itemBase(part);
    // Не влезает во вход - «не удалось» до вызова (решение арбитра `F06 | F06-2`, Р4).
    if (!(await this.llm.stageFit(AUTHOR_STAGE[part.target], part.author(null))).fits) {
      return { ...base, verdict: 'failed', outcome: 'none', failedReason: DRAFT_TOO_LONG };
    }
    const op = await this.prisma.llmOperation.findUnique({
      where: { id: operationId },
      select: { settingsSnapshot: true },
    });
    const snapshot = op?.settingsSnapshot ?? null;
    const key = partKey(part.target, base.number);
    const current = await this.fields.read(row, gate);
    if (!current) return null;
    const pending = slot.read(current);
    // Строку отбросили или перегенерацию сняли посреди цикла: дальше ни одного платного вызова
    // (решение арбитра, круг 3) - цикл обрывается, шаг кончается.
    const keep = async (resume: PendingText['resume']) => {
      const saved = await this.fields.mutate(row, gate, (data) =>
        slot.write(data, { key, operationId, resume }),
      );
      if (saved === null) throw new RunGone();
    };
    let result: Awaited<ReturnType<typeof runQualityLoop<string>>>;
    try {
      result = await this.runLoop(operationId, ctx, part, snapshot, keep, pending, key);
    } catch (error) {
      if (error instanceof RunGone) return null;
      throw error;
    }
    if (!result.ok) {
      return { ...base, verdict: 'failed', outcome: 'none', failedReason: DRAFT_INVALID_RESPONSE };
    }
    return this.itemOfResult(base, result.draft, result);
  }

  private runLoop(
    operationId: string,
    ctx: LlmTaskContext,
    part: PartInput,
    snapshot: Prisma.JsonValue | null,
    keep: (resume: PendingText['resume']) => Promise<void>,
    pending: PendingText | null,
    key: string,
  ) {
    return runQualityLoop(this.llm, operationId, ctx, {
      ...loopSpec(part, {
        author: runStageModels(snapshot, null, AUTHOR_STAGE[part.target]),
        review: runStageModels(snapshot, null, SUMMARY_REVIEW_STAGE),
      }),
      onAuthored: (a) => keep({ draft: a.draft, attempt: a.attempt, authorModel: a.authorModel }),
      onBeforeRedo: (first) =>
        keep({
          draft: first.draft,
          attempt: 1,
          authorModel: first.authorModel,
          checked: { remarks: first.remarks, review: first.review },
        }),
      resume:
        pending && pending.key === key && pending.operationId === operationId
          ? pending.resume
          : undefined,
    });
  }

  /** Итог цикла с текстом → текст хода: видимый текст и предел поля проверяются здесь же. */
  private itemOfResult(
    base: WriteItem,
    draft: string,
    result: Extract<Awaited<ReturnType<typeof runQualityLoop<string>>>, { ok: true }>,
  ): WriteItem {
    const html = summaryHtml(draft);
    // Запись идёт мимо валидаторов DTO ручек: длина и видимый текст - здесь же (`@RichHtml`).
    if (!hasVisibleText(html)) {
      return { ...base, verdict: 'failed', outcome: 'none', failedReason: DRAFT_INVALID_RESPONSE };
    }
    if (html.length > RICH_HTML_MAX_LENGTH.text) {
      return { ...base, verdict: 'failed', outcome: 'none', failedReason: DRAFT_TOO_LONG };
    }
    return {
      ...base,
      text: draft,
      attempt: result.attempt,
      verdict: result.verdict,
      remarks: result.remarks,
      review: result.review,
      authorModel: result.authorModel,
      outcome: 'waiting',
    };
  }

  private async contextOf(row: ContentDraft, dossier: unknown): Promise<PartContext> {
    const glossary = row.glossaryId
      ? await this.prisma.bookGlossary.findUnique({
          where: { id: row.glossaryId },
          select: { data: true },
        })
      : null;
    return { language: row.language, dossier, glossary: glossary?.data ?? null };
  }

  /**
   * Индекс цитат полного и «Очень кратко» по всей версии (`QUOTE_NOT_VERBATIM`): главы идут
   * страницами (`F05-Rb`), в памяти остаются только абзацы для сверки, а не строки глав с HTML.
   */
  private async quoteIndex(versionId: string): Promise<ChapterIndex> {
    const paragraphs = new Map<number, string>();
    for await (const page of chapterPages(this.prisma, versionId, {
      number: true,
      content: true,
    })) {
      for (const c of page) paragraphs.set(c.number, htmlToParagraphs(c.content));
    }
    return indexChapters(paragraphs);
  }

  /** Шаг, который строка уже не принимает: операция закрывается (уже закрытая - без изменений). */
  private async stepGone(operationId: string): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(operationId);
    return { kind: 'done' };
  }

  /** Конец хода: `ready` вместе с концом операции; операция не идёт - ждёт «Continue». */
  private async finish(row: ContentDraft): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(row.operationId, async (tx) => {
      await tx.contentDraft.updateMany({
        where: { id: row.id, status: 'building', operationId: row.operationId },
        data: { status: 'ready', waitingFor: null },
      });
    });
    return { kind: 'done' };
  }

  private async finishRegen(operationId: string): Promise<LlmTaskStepResult> {
    // Отметка снимается в той же транзакции, что закрывает операцию: обрыв между ними не оставляет
    // операцию без отметки, которую «Continue» уже не найдёт (круг 4).
    await this.tasks.completeOperation(operationId, (tx) => this.clearRegenMark(operationId, tx));
    return { kind: 'done' };
  }

  /** Окончательный отказ хода: операция `failed`, ход `failed` с причиной одной записью. */
  private async fail(row: ContentDraft, reason: string): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(row.operationId, async (tx) => {
      await tx.contentDraft.updateMany({
        where: { id: row.id, status: 'building' },
        data: { status: 'failed', failedReason: reason },
      });
    });
    return { kind: 'done' };
  }

  /** Деньги и отказ провайдеров - пауза своей причиной, прочее - `STEP_FAILED` (продолжаемо). */
  private async onFailed(task: LlmTask, reason: string): Promise<void> {
    await this.tasks.pauseOperation(task.operationId, PAUSE_BY_FAILURE[reason] ?? 'STEP_FAILED');
  }
}

/** Часть, которую не из чего писать: раздел без текста глав (`tech.md` §4 шаг 1). */
interface FailedPart {
  failed: string;
  target: SummaryTarget;
  source?: ReturnType<typeof sectionSource>;
}

function itemBase(part: {
  target: SummaryTarget;
  source?: ReturnType<typeof sectionSource>;
}): WriteItem {
  return {
    target: part.target,
    number: part.source?.section.number ?? null,
    title: part.source?.title ?? null,
    readerChapter: part.source?.readerChapter ?? null,
    chapters: part.source ? [...part.source.section.chapters].sort((a, b) => a - b) : null,
    text: '',
    attempt: 1,
    verdict: 'failed',
    remarks: [],
    review: null,
    outcome: 'none',
    failedReason: null,
    authorModel: null,
    fieldHash: null,
    fieldMode: null,
    fieldBase: null,
    regenFailedReason: null,
    regen: null,
  };
}

const failedItem = (part: FailedPart): WriteItem => ({
  ...itemBase(part),
  failedReason: part.failed,
});

/** Часть достройки - полный или «Очень кратко»; раздел сюда не попадает по построению. */
function tailTarget(target: SummaryTarget): 'full' | 'brief' {
  if (target === 'section') throw new Error('A section is not a tail part');
  return target;
}

/** Строка хода больше не принимает запись этой операции: цикл качества обрывается без вызовов. */
class RunGone extends Error {
  constructor() {
    super('The summary run no longer takes this step');
    this.name = 'RunGone';
  }
}
