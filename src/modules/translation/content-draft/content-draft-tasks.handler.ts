import { Injectable } from '@nestjs/common';
import { BookDossier, ContentDraft, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { demandContext, demandDossierContext } from '../dossier/context-demand';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { ContentDraftSectionDto } from '../dto/content-draft-response.dto';
import { DossierMotifDto } from '../dto/dossier-data.dto';
import { callShaped } from '../llm-shaped-call';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import {
  ANALYSIS_DRAFT_SHAPE,
  AnalysisDraftAnswer,
  analysisRemarks,
  buildAnalysisDraft,
  draftBlocksOf,
  indexChapters,
} from './content-draft.analysis';
import {
  ANALYSIS_DRAFT_REMARKS,
  ANALYSIS_DRAFT_STAGE,
  DRAFT_CANCELLED,
  DRAFT_INPUT_MISSING,
  DRAFT_INVALID_RESPONSE,
  DRAFT_NO_PLAN,
  DRAFT_TOO_LONG,
  SUMMARY_BRIEF_STAGE,
  SUMMARY_FULL_STAGE,
  SUMMARY_SECTIONS_STAGE,
} from './content-draft.constants';
import {
  analysisDraftRequest,
  SUMMARY_SECTION_SHAPE,
  SUMMARY_TEXT_SHAPE,
  summaryBriefRequest,
  summaryFullRequest,
  summarySectionRequest,
} from './content-draft.prompts';
import {
  ContentDraftService,
  DraftData,
  draftTaskInput,
  hasVisibleText,
  PlanSection,
  summaryPlanOf,
} from './content-draft.service';
import { answerToHtml, chaptersText, editorQuestion, htmlToParagraphs } from './content-draft.text';

/**
 * Мотивы досье для «Вводных» (Р10): главы - только этой версии; элемент не той формы пропускается,
 * как план разделов в `summaryPlanOf` (данные пишет код по форме, но шаг не должен падать на них).
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

function draftIdOf(task: LlmTask): string | null {
  const id = (task.payload as Record<string, unknown> | null)?.draftId;
  return typeof id === 'string' ? id : null;
}

/**
 * Шаги заготовки (`F05-10`). Одна задача на заготовку. Разделы: сначала досье и глоссарий
 * (строят свои операции, заготовка - ждущий по Р20), затем по разделу плана за шаг. Полный и
 * очень краткий - один вызов по сохранённому редактором. Пауза операции заготовку не меняет
 * (В1), `failed` - только окончательный отказ.
 *
 * 🔴 Раздел пишется до итога шага и после продления аренды, условием `status = 'building'`:
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
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const row = await this.prisma.contentDraft.findUnique({ where: { operationId: op.id } });
    return row?.status === 'building' ? [draftTaskInput(row)] : [];
  }

  /** Отмена со страницы операций (не «discard»): заготовка `failed` с причиной. */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.contentDraft.updateMany({
      where: { operationId: op.id, status: 'building' },
      data: { status: 'failed', failedReason: DRAFT_CANCELLED },
    });
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = draftIdOf(task);
    const row = id ? await this.prisma.contentDraft.findUnique({ where: { id } }) : null;
    // Строки нет (версию удалили - каскад) или она уже не строится (discard): делать нечего.
    if (!row || row.status !== 'building') {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: row.bookVersionId },
      select: { title: true },
    });
    const bookTitle = version?.title ?? '';
    // Полный, очень краткий или анализ уже записан (шаг оборвался на паузе после ответа): итог
    // без второго вызова модели.
    const written = row.data as DraftData | null;
    if (row.kind !== 'summary_sections' && (written?.text || written?.analysis)) {
      return this.markReady(row);
    }
    if (row.kind === 'summary_full') {
      const sections = await this.drafts.savedSections(row.bookVersionId);
      if (sections.length === 0) return this.fail(row, DRAFT_INPUT_MISSING);
      const request = summaryFullRequest({ bookTitle, language: row.language, sections });
      return this.textStep(row, SUMMARY_FULL_STAGE, request, ctx);
    }
    if (row.kind === 'summary_brief') {
      const fullText = await this.drafts.savedFull(row.bookVersionId);
      if (fullText === null) return this.fail(row, DRAFT_INPUT_MISSING);
      const request = summaryBriefRequest({ bookTitle, language: row.language, fullText });
      return this.textStep(row, SUMMARY_BRIEF_STAGE, request, ctx);
    }
    if (row.kind !== 'summary_sections' && row.kind !== 'analysis') {
      return this.fail(row, DRAFT_INPUT_MISSING);
    }

    if (!row.dossierId) return this.awaitContext(row);
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } });
    if (!dossier) return this.fail(row, DRAFT_INPUT_MISSING);
    if (row.kind === 'analysis') return this.analysisStep(row, dossier, bookTitle, ctx);
    const plan = summaryPlanOf(dossier.data);
    if (plan.length === 0) return this.fail(row, DRAFT_NO_PLAN);
    const data = (row.data ?? {}) as DraftData;
    const done = data.sections ?? [];
    if (done.length >= plan.length) {
      await this.tasks.completeOperation(row.operationId, async (tx) => {
        await tx.contentDraft.updateMany({
          where: { id: row.id, status: 'building' },
          data: { status: 'ready', waitingFor: null },
        });
      });
      return { kind: 'done' };
    }
    return this.sectionStep(row, dossier, plan, done, bookTitle, ctx);
  }

  private async sectionStep(
    row: ContentDraft,
    dossier: BookDossier,
    plan: PlanSection[],
    done: ContentDraftSectionDto[],
    bookTitle: string,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const section = plan[done.length];
    const chapters = await this.drafts.sectionChapters(row.bookVersionId, section);
    // Номер главы читалки - первая глава раздела плана; её нет среди глав версии - пусто
    // с пометкой, не подтягивается к ближайшей (В5).
    const first = section.chapters[0];
    const readerChapter =
      first !== undefined && chapters.some((c) => c.number === first) ? first : null;
    const base = {
      number: section.number,
      readerChapter,
      readerChapterMissing: readerChapter === null,
    };
    // Видимый текст - тот же разбор, что уходит в промпт: глава из пустых тегов и картинок
    // модели не отдаётся, иначе она пишет раздел по одному досье.
    const withText = chapters.filter((c) => htmlToParagraphs(c.content) !== '');
    // У глав раздела нет текста в этой версии: модель не зовётся, карточка покажет пустой раздел.
    if (withText.length === 0) {
      return this.saveSection(
        row,
        plan.length,
        done,
        {
          ...base,
          title: section.title,
          text: '',
          additions: null,
          question: null,
        },
        null,
        ctx,
      );
    }
    const glossary = row.glossaryId
      ? await this.prisma.bookGlossary.findUnique({
          where: { id: row.glossaryId },
          select: { data: true },
        })
      : null;
    const request = summarySectionRequest({
      bookTitle,
      language: row.language,
      dossier: dossier.data,
      glossary: glossary?.data ?? null,
      section,
      chaptersText: chaptersText(withText),
    });
    if (!(await this.llm.stageFit(SUMMARY_SECTIONS_STAGE, request)).fits) {
      return this.fail(row, DRAFT_TOO_LONG);
    }
    const answer = await callShaped(
      this.llm,
      row.operationId,
      SUMMARY_SECTIONS_STAGE,
      request,
      SUMMARY_SECTION_SHAPE,
      ctx,
      { remarks: 1 },
    );
    if (!answer.ok) return this.fail(row, DRAFT_INVALID_RESPONSE);
    const value = answer.value as {
      title: string;
      text: string;
      additions: string;
      question: string;
    };
    const text = answerToHtml(value.text);
    // Пустой ответ по форме - не раздел: в форму ушла бы пустая карточка «без текста».
    if (!hasVisibleText(text)) return this.fail(row, DRAFT_INVALID_RESPONSE);
    if (text.length > RICH_HTML_MAX_LENGTH.text) return this.fail(row, DRAFT_TOO_LONG);
    return this.saveSection(
      row,
      plan.length,
      done,
      {
        ...base,
        // Предел заголовка раздела (F04): длиннее «Add section» отказал бы.
        title: (value.title.trim() || section.title).slice(0, SUMMARY_SECTION_LIMITS.title),
        text,
        additions: editorQuestion(value.additions),
        question: editorQuestion(value.question),
      },
      answer.model,
      ctx,
    );
  }

  private async saveSection(
    row: ContentDraft,
    planned: number,
    done: ContentDraftSectionDto[],
    section: ContentDraftSectionDto,
    model: string | null,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    await ctx.renewLease();
    const data: DraftData = { plannedSections: planned, sections: [...done, section] };
    const saved = await this.prisma.contentDraft.updateMany({
      where: { id: row.id, status: 'building' },
      data: {
        data: data as unknown as Prisma.InputJsonValue,
        ...(model ? { model } : {}),
      },
    });
    return saved.count === 0 ? { kind: 'done' } : { kind: 'continue' };
  }

  /** Полный или очень краткий: один вызов, черновик и `ready` одной записью итога. */
  private async textStep(
    row: ContentDraft,
    stage: typeof SUMMARY_FULL_STAGE | typeof SUMMARY_BRIEF_STAGE,
    request: ReturnType<typeof summaryFullRequest>,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    if (!(await this.llm.stageFit(stage, request)).fits) return this.fail(row, DRAFT_TOO_LONG);
    const answer = await callShaped(
      this.llm,
      row.operationId,
      stage,
      request,
      SUMMARY_TEXT_SHAPE,
      ctx,
      {
        remarks: 1,
      },
    );
    if (!answer.ok) return this.fail(row, DRAFT_INVALID_RESPONSE);
    const value = answer.value as { text: string; question: string };
    const text = answerToHtml(value.text);
    // Пустой ответ по форме - не заготовка: подстановка затёрла бы поле пустотой.
    if (!hasVisibleText(text)) return this.fail(row, DRAFT_INVALID_RESPONSE);
    if (text.length > RICH_HTML_MAX_LENGTH.text) return this.fail(row, DRAFT_TOO_LONG);
    const data: DraftData = { text, question: editorQuestion(value.question) };
    // 🔴 Ответ пишется до итога шага, отдельно от перехода операции: операцию могли поставить
    // на паузу, пока шёл вызов, - тогда `completeOperation` ничего не делает, а оплаченный
    // ответ должен дождаться «продолжить», а не уйти на второй вызов.
    await ctx.renewLease();
    const saved = await this.prisma.contentDraft.updateMany({
      where: { id: row.id, status: 'building' },
      data: { data: data as unknown as Prisma.InputJsonValue, model: answer.model },
    });
    if (saved.count === 0) return { kind: 'done' };
    return this.markReady(row);
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
  private async awaitContext(row: ContentDraft): Promise<LlmTaskStepResult> {
    const { sourceVersionId } = await this.dossiers.dossierSourceOf(row.bookVersionId);
    const sameLanguage = (await this.drafts.languageOf(sourceVersionId)) === row.language;
    const input = {
      versionId: row.bookVersionId,
      operationId: row.operationId,
      waitingFor: row.waitingFor,
    };
    const context = sameLanguage
      ? await demandDossierContext(this.dossiers, this.tasks, input)
      : await demandContext(this.dossiers, this.tasks, { ...input, language: row.language });
    switch (context.kind) {
      case 'ready':
        await this.prisma.contentDraft.updateMany({
          where: { id: row.id, status: 'building' },
          data: {
            dossierId: context.dossier.id,
            glossaryId: context.glossary?.id ?? null,
            waitingFor: null,
          },
        });
        return { kind: 'continue' };
      case 'wait':
        if (row.waitingFor !== context.waitingFor) {
          await this.prisma.contentDraft.updateMany({
            where: { id: row.id, status: 'building' },
            data: { waitingFor: context.waitingFor },
          });
        }
        return { kind: 'wait', reason: context.reason };
      case 'stopped':
        return { kind: 'continue' };
      // Строку меняли одновременно - «повторить позже», а не отказ.
      case 'retry':
        return { kind: 'wait', reason: context.code };
      case 'failed':
        return { kind: 'fail', reason: context.code };
    }
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
