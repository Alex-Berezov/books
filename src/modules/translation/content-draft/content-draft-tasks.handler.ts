import { Injectable } from '@nestjs/common';
import { BookDossier, ContentDraft, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { DossierMotifDto } from '../dto/dossier-data.dto';
import { callShaped } from '../llm-shaped-call';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import {
  ANALYSIS_DRAFT_SHAPE,
  AnalysisDraftAnswer,
  analysisRemarks,
  buildAnalysisDraft,
  draftBlocksOf,
} from './content-draft.analysis';
import { indexChapters } from '../draft-quality/quote-check';
import {
  ANALYSIS_DRAFT_REMARKS,
  ANALYSIS_DRAFT_STAGE,
  DRAFT_CANCELLED,
  DRAFT_INPUT_MISSING,
  DRAFT_INVALID_RESPONSE,
  DRAFT_TOO_LONG,
  RETIRED_SUMMARY_DRAFT_KINDS,
} from './content-draft.constants';
import { analysisDraftRequest } from './content-draft.prompts';
import { ContentDraftService, DraftData, draftTaskInput } from './content-draft.service';
import { chaptersText, htmlToParagraphs } from './content-draft.text';
import { awaitDraftContext } from './draft-context-wait';
import { summaryWriteTaskInput, SummaryWriteHandler } from '../summary-write/summary-write.handler';
import { runTaskPayload } from '../draft-quality/run-regen';
import {
  AnalysisWriteHandler,
  analysisWriteTaskInput,
} from '../analysis-write/analysis-write.handler';

/**
 * Мотивы досье для «Вводных» (Р10): главы - только этой версии; элемент не той формы пропускается,
 * как план разделов в `summaryPlanOf` хода (данные пишет код по форме, но шаг не должен падать на них).
 */
function motifsOf(dossierData: unknown, numbers: ReadonlySet<number>): DossierMotifDto[] {
  const motifs = (dossierData as { motifs?: unknown } | null)?.motifs;
  if (!Array.isArray(motifs)) return [];
  return motifs.flatMap((m) => {
    const e = m as Partial<DossierMotifDto> | null;
    if (!e || typeof e.image !== 'string') return [];
    const chapters = Array.isArray(e.chapters) ? e.chapters : [];
    return [{ image: e.image, chapters: chapters.filter((n) => numbers.has(n)) }];
  });
}

/** Операция заведена запуском перевода (автозапуск и ход `F06-5`); перегенерации его не несут. */
const isRunOperation = (op: Pick<LlmOperation, 'translationRunId'>): boolean =>
  typeof op.translationRunId === 'string';

/**
 * Шаги заготовки Analysis (`F05-11`). Одна задача на заготовку: сначала досье и глоссарий
 * (строят свои операции, заготовка - ждущий по Р20), затем один вызов. Пауза операции заготовку
 * не меняет (В1), `failed` - только окончательный отказ. Строящаяся заготовка снятого вида
 * Summary (`F05-10`, снят в `F06-3`) отбрасывается тем же путём, что дренаж при старте (А1).
 *
 * 🔴 Ответ пишется до итога шага и после продления аренды, условием `status = 'building'`:
 * повтор после обрыва найдёт его сохранённым и модель не позовёт, а ответ после «discard»
 * заготовку не воскресит (В10).
 */
@Injectable()
export class ContentDraftTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierDemandService,
    private readonly drafts: ContentDraftService,
    private readonly summaryWrite: SummaryWriteHandler,
    private readonly analysisWrite: AnalysisWriteHandler,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  /**
   * «Continue» операции `draft`: заготовка, ход пересказа (`F06-2`) и ход анализа (`F07-1b`) -
   * своей задачей; строки с этой операцией нет - это операция перегенерации текста или блока хода
   * (решение арбитра `F06 | F06-2`, Р2) или автозапуска (`F06-5`): у перегенерации
   * `translationRunId` нет никогда, автозапуск закрывает свою операцию сам - продолжать нечего
   * (решение арбитра `F06 | F06-5`, Р4).
   */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const row = await this.prisma.contentDraft.findUnique({ where: { operationId: op.id } });
    if (!row) return isRunOperation(op) ? [] : this.regenResume(op);
    if (row.status !== 'building') return [];
    // Ход анализа свой задачей: задача заготовки отбила бы строку чужого вида (Л1 `F07-1a`).
    if (row.kind === 'analysis_write') return [analysisWriteTaskInput(row, row.operationId)];
    return row.kind === 'summary_write'
      ? [summaryWriteTaskInput(row, row.operationId)]
      : [draftTaskInput(row)];
  }

  /** Перегенерация хода: блок ищется у обоих видов хода по отметке операции. */
  private async regenResume(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const summary = await this.summaryWrite.regenResume(op);
    return summary.length > 0 ? summary : this.analysisWrite.regenResume(op);
  }

  /**
   * Отмена со страницы операций (не «discard»): заготовка и ход `failed` с причиной; операция
   * перегенерации снимает отметку у своего текста, ход остаётся `ready` (Р2).
   */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.contentDraft.updateMany({
      where: { operationId: op.id, status: 'building' },
      data: { status: 'failed', failedReason: DRAFT_CANCELLED },
    });
    // Операция запуска (ход и автозапуск `F06-5`) - не перегенерация: отметок текста у неё нет (Р4).
    if (!isRunOperation(op)) {
      await this.summaryWrite.onRegenCancelled(op, tx);
      await this.analysisWrite.onRegenCancelled(op, tx);
    }
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = runTaskPayload(task).draftId;
    const row = id ? await this.prisma.contentDraft.findUnique({ where: { id } }) : null;
    // Строки нет (версию удалили - каскад) или она уже не строится (discard): делать нечего.
    if (!row || row.status !== 'building') {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    // Снятый вид Summary (окно выката до дренажа при старте): отбросить, а не уронить (А1).
    if ((RETIRED_SUMMARY_DRAFT_KINDS as readonly string[]).includes(row.kind)) {
      await this.drafts.discardRetired(row);
      return { kind: 'done' };
    }
    if (row.kind !== 'analysis') return this.fail(row, DRAFT_INPUT_MISSING);
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: row.bookVersionId },
      select: { title: true },
    });
    const bookTitle = version?.title ?? '';
    // Анализ уже записан (шаг оборвался на паузе после ответа): итог без второго вызова модели.
    const written = row.data as DraftData | null;
    if (written?.analysis) return this.markReady(row);

    if (!row.dossierId) return this.awaitContext(row);
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } });
    if (!dossier) return this.fail(row, DRAFT_INPUT_MISSING);
    return this.analysisStep(row, dossier, bookTitle, ctx);
  }

  /**
   * Анализ (`F05-11`): один вызов на весь текст версии (Р8). Ответ сливается с сохранённым
   * анализом кодом, новые цитаты сверяются с текстом своей главы, итог проходит проверки
   * сохранения анализа - не прошёл, замечание модели и один повтор (Р2). Пишется тем же
   * порядком, что текст: ответ до итога шага, условием `status = 'building'` (В10).
   */
  private async analysisStep(
    row: ContentDraft,
    dossier: BookDossier,
    bookTitle: string,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const chapters = await this.drafts.versionChapters(row.bookVersionId);
    // Текст сам перешёл вход модели: остаток не читается (Р2 `F05-Rb`).
    if (chapters === null) return this.fail(row, DRAFT_TOO_LONG);
    if (chapters.length === 0) return this.fail(row, DRAFT_INPUT_MISSING);
    const { stored, updatedAt } = await this.drafts.storedAnalysis(row.bookVersionId);
    const glossary = row.glossaryId
      ? await this.prisma.bookGlossary.findUnique({
          where: { id: row.glossaryId },
          select: { data: true },
        })
      : null;
    const request = analysisDraftRequest({
      bookTitle,
      language: row.language,
      dossier: dossier.data,
      glossary: glossary?.data ?? null,
      stored: draftBlocksOf(stored),
      chaptersText: chaptersText(chapters),
    });
    if (!(await this.llm.stageFit(ANALYSIS_DRAFT_STAGE, request)).fits) {
      return this.fail(row, DRAFT_TOO_LONG);
    }
    // Текст главы для сверки цитат - тот же разбор, что уходит модели: без тегов, сущности
    // раскодированы (Р5).
    const texts = indexChapters(
      new Map(chapters.map((c) => [c.number, htmlToParagraphs(c.content)])),
    );
    const build = (value: unknown) =>
      buildAnalysisDraft({
        language: row.language,
        stored,
        answer: value as AnalysisDraftAnswer,
        chapters: texts,
      });
    const answer = await callShaped(
      this.llm,
      row.operationId,
      ANALYSIS_DRAFT_STAGE,
      request,
      ANALYSIS_DRAFT_SHAPE,
      ctx,
      {
        remarks: ANALYSIS_DRAFT_REMARKS,
        extraErrors: (value) => analysisRemarks(stored, build(value).analysis),
      },
    );
    if (!answer.ok) return this.fail(row, DRAFT_INVALID_RESPONSE);
    const { analysis, droppedQuotes } = build(answer.value);
    const sourceLanguage = await this.drafts.languageOf(dossier.sourceVersionId);
    const numbers = new Set(chapters.map((c) => c.number));
    const motifs = motifsOf(dossier.data, numbers);
    const data: DraftData = {
      analysis,
      droppedQuotes,
      motifs,
      dossierLanguage: sourceLanguage,
      analysisUpdatedAt: updatedAt,
    };
    await ctx.renewLease();
    const saved = await this.prisma.contentDraft.updateMany({
      where: { id: row.id, status: 'building' },
      data: { data: data as unknown as Prisma.InputJsonValue, model: answer.model },
    });
    if (saved.count === 0) return { kind: 'done' };
    return this.markReady(row);
  }

  /**
   * Записанный результат (текст или анализ) - `ready` вместе с концом операции; операция не идёт -
   * ждёт «продолжить».
   */
  private async markReady(row: ContentDraft): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(row.operationId, async (tx) => {
      await tx.contentDraft.updateMany({
        where: { id: row.id, status: 'building' },
        data: { status: 'ready' },
      });
    });
    return { kind: 'done' };
  }

  /**
   * Досье и глоссарий языка версии (Р5, Р20): заготовка - ждущий. На языке досье глоссарий
   * не запрашивается (В6). `paused`/`failed` - операция уже на паузе, шаг кончается.
   */
  private awaitContext(row: ContentDraft): Promise<LlmTaskStepResult> {
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

  /** Окончательный отказ: операция `failed`, заготовка `failed` с причиной одной записью. */
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
