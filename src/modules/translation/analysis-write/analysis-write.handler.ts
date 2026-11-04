import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentDraft, LlmTask } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { allChapters } from '../chapter-pages';
import {
  DRAFT_DATA_INVALID,
  DRAFT_INPUT_MISSING,
  DRAFT_INVALID_RESPONSE,
  DRAFT_TOO_LONG,
} from '../content-draft/content-draft.constants';
import { ContentDraftService } from '../content-draft/content-draft.service';
import { htmlToParagraphs } from '../content-draft/content-draft.text';
import { awaitDraftContext } from '../content-draft/draft-context-wait';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { QualityLoopResult, runQualityLoop } from '../draft-quality/quality-loop';
import { indexChapters } from '../draft-quality/quote-check';
import { DraftRemark } from '../draft-quality/text-checks';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import { runStageModels } from '../run/run-models';
import { blockOfPath, stepDroppedQuotes } from './analysis-checks';
import {
  ANALYSIS_REVIEW_STAGE,
  ANALYSIS_STEPS,
  ANALYSIS_WRITE_TASK_KIND,
} from './analysis-write.constants';
import {
  AnalysisItem,
  AnalysisStep,
  AnalysisStepNumber,
  AnalysisTarget,
  AnalysisWriteData,
  blocksValue,
  PendingStep,
  STEP_TARGETS,
  StepBlocks,
  StepDraft,
  StepSource,
  stepKey,
} from './analysis-write.data';
import { analysisRunGate, AnalysisGate, AnalysisWriteFields } from './analysis-write.fields';
import { STEP_STAGES } from './analysis-write.prompts';
import {
  StepContext,
  StepInput,
  fitStepInput,
  stepInputFits,
  stepLoopSpec,
} from './analysis-write.steps';
import { otherLanguageKeys } from './analysis-keys';

/** Задача хода анализа: одна задача - один шаг, продолжение - следующей задачей. */
export function analysisWriteTaskInput(
  row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: ANALYSIS_WRITE_TASK_KIND,
    operationId,
    bookVersionId: row.bookVersionId,
    language: row.language,
    payload: { draftId: row.id },
    pairKey: `${operationId}:${row.id}`,
  };
}

function draftIdOf(task: LlmTask): string | null {
  const id = (task.payload as Record<string, unknown> | null)?.draftId;
  return typeof id === 'string' ? id : null;
}

/** Строка хода больше не принимает запись этой операции: цикл качества обрывается без вызовов. */
class RunGone extends Error {
  constructor() {
    super('The analysis run no longer takes this step');
    this.name = 'RunGone';
  }
}

type LoopDraft = Extract<QualityLoopResult<StepDraft>, { ok: true }>;

/** Блоки, которые знает разбор места замечания (`where` начинается с пути поля). */
const BLOCK_NAMES = new Set([
  'facts',
  'characters',
  'keyQuotes',
  'style',
  'mainIdea',
  'themes',
  'symbols',
  'titleMeaning',
  'endingMeaning',
]);

/**
 * Замечания блока: у замечания с путём поля - только своего блока (`facts.<подполе>` - своего
 * подполя), без пути - у всех блоков шага. `CORE_MISSING` - флаг шага, не блока.
 */
export function remarksOfTarget(
  remarks: readonly DraftRemark[],
  target: AnalysisTarget,
): DraftRemark[] {
  return remarks.filter((r) => {
    if (r.code === 'CORE_MISSING') return false;
    const block = blockOfPath(r.where);
    if (!BLOCK_NAMES.has(block)) return true;
    if (!target.startsWith('facts.')) return block === target;
    const path = r.where.split(':', 1)[0];
    return path === 'facts' || path === target || path.startsWith(`${target}.`);
  });
}

/** Итоги шага поверх итогов прошлых шагов; `facts` - по подполям. */
function mergeSteps(merged: StepBlocks, blocks: StepBlocks): StepBlocks {
  const out: StepBlocks = { ...merged, ...blocks };
  if (merged.facts && blocks.facts) out.facts = { ...merged.facts, ...blocks.facts };
  return out;
}

/**
 * Цель записи по пути замечания `IMPORT_INVALID`: у `facts` - подполе (`facts.narrator`, второй
 * сегмент пути; решение арбитра `F07 | F07-1a`, А2), путь без подполя - весь `facts`; прочие
 * блоки - по блоку (К4).
 */
function invalidTarget(where: string): string {
  const block = blockOfPath(where);
  if (block !== 'facts') return block;
  const field = where.split(/[.[:]/, 2)[1];
  return field ? `facts.${field}` : 'facts';
}

/** Цель не пишется: её путь остался с `IMPORT_INVALID`, у подполя `facts` - и весь `facts`. */
function isInvalidTarget(invalid: ReadonlySet<string>, target: string): boolean {
  return invalid.has(target) || (target.startsWith('facts.') && invalid.has('facts'));
}

/**
 * Блоки шага без тех, что остались с `IMPORT_INVALID` после переделки: они не пишутся; у `facts`
 * снимается только подполе ошибки (А2), остальные подполя пишутся.
 */
export function withoutInvalid(
  blocks: StepBlocks,
  remarks: readonly DraftRemark[],
): { valid: StepBlocks; invalid: Set<string> } {
  const invalid = new Set(
    remarks.filter((r) => r.code === 'IMPORT_INVALID').map((r) => invalidTarget(r.where)),
  );
  const valid = Object.fromEntries(
    Object.entries(blocks).filter(([key]) => key === 'facts' || !invalid.has(key)),
  ) as StepBlocks;
  if (valid.facts) {
    const facts = Object.fromEntries(
      Object.entries(valid.facts).filter(([field]) => !isInvalidTarget(invalid, `facts.${field}`)),
    );
    if (Object.keys(facts).length > 0) valid.facts = facts;
    else delete valid.facts;
  }
  return { valid, invalid };
}

/**
 * Шаги хода анализа «Write Analysis» (`F07-1a`; `features/F07-analysis-autofill/tech.md` §2-§3, §5):
 * шаг 1 - карточка и герои, шаг 2 - цитаты и приёмы, шаг 3 - толкования и связи тем; каждый -
 * циклом качества `F06-1` со своими кодами проверяющей, запись после каждого шага (обрыв не теряет
 * готового). После шага 3 ход `ready` (решение арбитра `F07 | F07-1`, В4). Пауза операции ход не
 * меняет; оплаченный текст шага сохраняется до проверяющей и до переделки (`F06 | F06-2`, Р3).
 */
@Injectable()
export class AnalysisWriteHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierDemandService,
    private readonly drafts: ContentDraftService,
    private readonly fields: AnalysisWriteFields,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = draftIdOf(task);
    const row = id ? await this.prisma.contentDraft.findUnique({ where: { id } }) : null;
    // Ход отбросили, он кончился или задача не его операции: делать нечего.
    if (
      !row ||
      row.kind !== 'analysis_write' ||
      row.status !== 'building' ||
      row.operationId !== task.operationId
    ) {
      return this.stepGone(task.operationId);
    }
    if (!row.dossierId) {
      return awaitDraftContext(
        {
          db: this.prisma,
          tasks: this.tasks,
          dossiers: this.dossiers,
          languageOf: (versionId) => this.drafts.languageOf(versionId),
        },
        row,
      );
    }
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } });
    if (!dossier) return this.fail(row, DRAFT_INPUT_MISSING);
    const gate = analysisRunGate(row.operationId);
    try {
      return await this.runStep(row, gate, dossier.data, ctx);
    } catch (error) {
      // Версию удалили посреди записи (сервис анализа - 404): писать некуда.
      if (error instanceof NotFoundException) return this.fail(row, DRAFT_INPUT_MISSING);
      throw error;
    }
  }

  private async runStep(
    row: ContentDraft,
    gate: AnalysisGate,
    dossier: unknown,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    let data = await this.fields.read(row, gate);
    if (!data) return this.stepGone(row.operationId);
    // Запись шага не той формы: номер следующего шага не вывести, оплаченный шаг не повторяется.
    if (data.stepsBroken) return this.fail(row, DRAFT_DATA_INVALID);
    // Итог шага сохранён, а запись не дошла (обрыв между записями): дописать.
    const waiting = [
      ...new Set(data.items.filter((i) => i.outcome === 'waiting').map((i) => i.step)),
    ];
    for (const step of waiting) {
      if ((await this.fields.settleStep(row, gate, step)) === 'gone') {
        return this.stepGone(row.operationId);
      }
    }
    data = await this.fields.read(row, gate);
    if (!data) return this.stepGone(row.operationId);
    const step = data.steps.length + 1;
    if (step > ANALYSIS_STEPS) {
      if ((await this.fields.markCore(row, gate)) === null) return this.stepGone(row.operationId);
      return this.finish(row);
    }
    const n = step as AnalysisStepNumber;
    const context = await this.contextOf(row, dossier, data);
    const record = await this.produceStep(row, gate, n, context, data.pending, ctx);
    if (record === null) return this.stepGone(row.operationId);
    await ctx.renewLease();
    const saved = await this.fields.mutate(row, gate, (current) =>
      current.steps.length + 1 === n ? withStep(current, record) : null,
    );
    if (!saved) return this.stepGone(row.operationId);
    // Шаг уже записан другой попыткой (аренда истекла посреди вызова): этот итог не пишется и не
    // решается - следующий шаг начнёт с записанного.
    if (!saved.written) return { kind: 'continue' };
    if ((await this.fields.settleStep(row, gate, n)) === 'gone') {
      return this.stepGone(row.operationId);
    }
    return { kind: 'continue' };
  }

  /**
   * Вход шага, который влезает (`fitStepInput`, Р8): и запрос автора, и запрос проверяющей с тем
   * же входом и запасом на ответ автора (`stepInputFits`) - иначе проверяющая молча отпала бы
   * `too_long` на длинной книге после оплаченного шага автора.
   */
  private fittingInput(
    step: AnalysisStepNumber,
    context: StepContext,
    quotes: ReturnType<typeof indexChapters>,
  ): Promise<{ input: StepInput; source: StepSource } | null> {
    return fitStepInput(step, context, quotes, (input) => stepInputFits(this.llm, input));
  }

  /** Шаг: цикл качества и итог; `null` - ход больше не принимает шаг этой операции. */
  private async produceStep(
    row: ContentDraft,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
    context: StepContext,
    pending: PendingStep | null,
    ctx: LlmTaskContext,
  ): Promise<StepRecord | null> {
    const quotes = indexChapters(
      new Map(context.chapters.map((c) => [c.number, htmlToParagraphs(c.content)])),
    );
    const fit = await this.fittingInput(step, context, quotes);
    if (fit === null) return failedRecord(step, DRAFT_TOO_LONG, null);
    const op = await this.prisma.llmOperation.findUnique({
      where: { id: row.operationId },
      select: { settingsSnapshot: true },
    });
    const snapshot = op?.settingsSnapshot ?? null;
    const key = stepKey(step);
    const keep = async (resume: PendingStep['resume']) => {
      const saved = await this.fields.mutate(row, gate, (data) => ({
        ...data,
        pending: { key, operationId: row.operationId, resume },
      }));
      if (saved === null) throw new RunGone();
    };
    let result: QualityLoopResult<StepDraft>;
    try {
      result = await runQualityLoop(this.llm, row.operationId, ctx, {
        ...stepLoopSpec(fit.input, {
          author: runStageModels(snapshot, null, STEP_STAGES[step]),
          review: runStageModels(snapshot, null, ANALYSIS_REVIEW_STAGE),
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
          pending && pending.key === key && pending.operationId === row.operationId
            ? pending.resume
            : undefined,
      });
    } catch (error) {
      if (error instanceof RunGone) return null;
      throw error;
    }
    if (!result.ok) return failedRecord(step, DRAFT_INVALID_RESPONSE, fit.source);
    return doneRecord(step, result, fit.source);
  }

  /** Досье, глоссарий, главы, сохранённый анализ и ключи другого языка - вход шага. */
  private async contextOf(
    row: ContentDraft,
    dossier: unknown,
    data: AnalysisWriteData,
  ): Promise<StepContext> {
    const [version, glossary, chapters, state, otherKeys] = await Promise.all([
      this.prisma.bookVersion.findUnique({
        where: { id: row.bookVersionId },
        select: { title: true, author: true },
      }),
      row.glossaryId
        ? this.prisma.bookGlossary.findUnique({
            where: { id: row.glossaryId },
            select: { data: true },
          })
        : null,
      allChapters(this.prisma, row.bookVersionId, { number: true, title: true, content: true }),
      this.fields.state(this.prisma, row.bookVersionId),
      otherLanguageKeys(this.prisma, this.dossiers, row.bookVersionId, row.language),
    ]);
    return {
      language: row.language,
      dossier,
      glossary: glossary?.data ?? null,
      bookTitle: version?.title ?? '',
      author: version?.author ?? '',
      stored: state.stored,
      merged: data.merged,
      chapters: chapters.filter((c) => htmlToParagraphs(c.content) !== ''),
      otherKeys,
    };
  }

  private async stepGone(operationId: string): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(operationId);
    return { kind: 'done' };
  }

  /** Конец хода: `ready` вместе с концом операции (В4). */
  private async finish(row: ContentDraft): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(row.operationId, async (tx) => {
      await tx.contentDraft.updateMany({
        where: { id: row.id, status: 'building', operationId: row.operationId },
        data: { status: 'ready', waitingFor: null },
      });
    });
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

/** Итог шага до записи: запись шага, блоки к записи, связи и выброшенные цитаты. */
export interface StepRecord {
  step: AnalysisStep;
  draft: StepDraft | null;
  /**
   * Цели, не прошедшие импорт после переделки, - не пишутся (`product.md` §8 п.3): блок, у `facts` -
   * подполе (`facts.narrator`) или весь `facts`.
   */
  invalid: Set<string>;
  review: AnalysisItem['review'];
}

function failedRecord(
  step: AnalysisStepNumber,
  reason: string,
  source: StepSource | null,
): StepRecord {
  return {
    step: {
      step,
      verdict: 'failed',
      remarks: [],
      attempt: 1,
      outcome: 'failed',
      failedReason: reason,
      authorModel: null,
      review: null,
      source,
      dropped: [],
    },
    draft: null,
    invalid: new Set(),
    review: null,
  };
}

function doneRecord(step: AnalysisStepNumber, result: LoopDraft, source: StepSource): StepRecord {
  const { valid, invalid } = withoutInvalid(result.draft.blocks, result.remarks);
  const remarks = [...result.remarks];
  return {
    step: {
      step,
      verdict: result.verdict,
      remarks,
      attempt: result.attempt,
      outcome: 'done',
      failedReason: null,
      authorModel: result.authorModel,
      review: result.review,
      source,
      dropped: result.draft.fixes,
    },
    draft: { ...result.draft, blocks: valid },
    invalid,
    review: result.review,
  };
}

/**
 * Итог шага в данных хода: запись шага, итоги поверх прошлых, связи тем, выброшенные цитаты и
 * ждущие блоки шага - решение о записи принимает `settleStep` под замком.
 */
export function withStep(data: AnalysisWriteData, record: StepRecord): AnalysisWriteData {
  const n = record.step.step;
  const items = [...data.items];
  const blocks = record.draft?.blocks ?? {};
  const answered = record.review?.kind === 'answered';
  for (const target of STEP_TARGETS[n]) {
    const value = blocksValue(blocks, target);
    const remarks = remarksOfTarget(record.step.remarks, target);
    if (value === undefined) {
      if (!isInvalidTarget(record.invalid, target)) continue;
      items.push(item(target, n, 'failed', remarks, record, 'none', null, 'IMPORT_INVALID'));
      continue;
    }
    const verdict = remarks.length === 0 && answered ? 'ok' : 'flags';
    items.push(item(target, n, verdict, remarks, record, 'waiting', value, null));
  }
  const links = record.draft?.themeLinks ?? null;
  if (n === 3 && links) {
    if (Object.keys(links.characters).length > 0) {
      items.push({
        ...item('characters', 3, answered ? 'ok' : 'flags', [], record, 'waiting', null, null),
        links: true,
      });
    }
    if (Object.keys(links.keyQuotes).length > 0) {
      items.push({
        ...item('keyQuotes', 3, answered ? 'ok' : 'flags', [], record, 'waiting', null, null),
        links: true,
      });
    }
  }
  return {
    ...data,
    steps: [...data.steps, record.step],
    items,
    merged: mergeSteps(data.merged, blocks),
    themeLinks: n === 3 ? links : data.themeLinks,
    droppedQuotes: [
      ...data.droppedQuotes,
      ...stepDroppedQuotes(n, record.draft?.droppedQuotes ?? []),
    ],
    pending: null,
  };
}

function item(
  target: AnalysisTarget,
  step: AnalysisStepNumber,
  verdict: AnalysisItem['verdict'],
  remarks: DraftRemark[],
  record: StepRecord,
  outcome: AnalysisItem['outcome'],
  value: unknown,
  failedReason: string | null,
): AnalysisItem {
  return {
    target,
    step,
    verdict,
    remarks,
    review: record.review,
    outcome,
    hash: null,
    value,
    failedReason,
    links: false,
  };
}
