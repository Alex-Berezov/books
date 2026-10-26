import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BookDossier,
  ContentDraft,
  ContentDraftKind,
  Language,
  LlmOperation,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { utcTimestamp } from '../../../shared/prisma/utc-timestamp';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import {
  BOOK_ANALYSIS_SELECT,
  readStoredAnalysis,
  StoredBookAnalysis,
} from '../../book-analysis/book-analysis-data';
import { DOSSIER_MAX_CHAPTERS } from '../dossier/dossier.constants';
import { ContextEstimate, DossierService } from '../dossier/dossier.service';
import { DossierMotifDto, DossierSummarySectionDto } from '../dto/dossier-data.dto';
import {
  ContentDraftDto,
  ContentDraftEstimateDto,
  ContentDraftSectionDto,
  ContentDraftStateDto,
} from '../dto/content-draft-response.dto';
import { stageEstimatorFor } from '../llm-model-checks';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  CONTENT_DRAFT_TASK_KIND,
  DOSSIER_STALE,
  DRAFT_DOSSIER_MISSING,
  DRAFT_IN_PROGRESS,
  DRAFT_LIMIT_FACTOR,
  DRAFT_LIMIT_TOO_LOW,
  DRAFT_NOT_READY,
  DRAFT_SECTION_UNKNOWN,
  DRAFT_TX_OPTIONS,
  SUMMARY_FULL_MISSING,
  SUMMARY_SECTIONS_MISSING,
  SUMMARY_SECTIONS_STAGE,
  ANALYSIS_DRAFT_REMARKS,
  ANALYSIS_DRAFT_STAGE,
  DRAFT_STAGE_BY_KIND,
} from './content-draft.constants';
import { AnalysisDraftJson, draftBlocksOf, DroppedQuote } from './content-draft.analysis';
import {
  analysisDraftRequest,
  summaryBriefRequest,
  summaryFullRequest,
  summarySectionRequest,
} from './content-draft.prompts';
import { chaptersText, htmlToParagraphs } from './content-draft.text';

/** Раздел плана досье (`DossierV1.summaryPlan`): тип - DTO досье, форма меняется вместе с ним. */
export type PlanSection = Pick<DossierSummarySectionDto, 'number' | 'title' | 'chapters'>;

/** Данные заготовки в `ContentDraft.data`: разделы по мере готовности или текст. */
export interface DraftData {
  plannedSections?: number;
  sections?: ContentDraftSectionDto[];
  /** Номера разделов, которые редактор уже добавил «Add section» (решение арбитра `F05 | F05-10`, Р1). */
  addedSections?: number[];
  text?: string;
  question?: string | null;
  /** Заготовка Analysis (`F05-11`): JSON импорта F03 и выкинутые цитаты (Р9). */
  analysis?: AnalysisDraftJson;
  droppedQuotes?: DroppedQuote[];
  /** Сквозные мотивы досье снимком при сборке, главы - только этой версии (Р10). */
  motifs?: DossierMotifDto[];
  dossierLanguage?: Language | null;
  /** `updatedAt` анализа, поверх которого собрана заготовка; анализа не было - `null` (Р15). */
  analysisUpdatedAt?: string | null;
}

/** Задача заготовки: ключ пары «операция:заготовка» - «продолжить» второй задачи не поставит. */
export function draftTaskInput(draft: {
  id: string;
  bookVersionId: string;
  language: Language;
  operationId: string;
}): EnqueueTaskInput {
  return {
    kind: CONTENT_DRAFT_TASK_KIND,
    operationId: draft.operationId,
    bookVersionId: draft.bookVersionId,
    language: draft.language,
    payload: { draftId: draft.id },
    pairKey: `${draft.operationId}:${draft.id}`,
  };
}

/** План разделов из данных досье: элемент не той формы пропускается (данные пишет код по форме). */
export function summaryPlanOf(dossierData: unknown): PlanSection[] {
  const plan = (dossierData as { summaryPlan?: unknown } | null)?.summaryPlan;
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((p) => {
    const e = p as Partial<PlanSection> | null;
    return e &&
      Number.isInteger(e.number) &&
      typeof e.title === 'string' &&
      Array.isArray(e.chapters)
      ? [
          {
            number: e.number as number,
            title: e.title,
            chapters: e.chapters.filter(Number.isInteger),
          },
        ]
      : [];
  });
}

/** В HTML есть видимый текст - той же нормализацией, что `@RichHtmlHasText` у сохранения. */
export const hasVisibleText = (html: string | null | undefined): boolean =>
  !!html && richHtmlText(html) !== '';

type ContextLine = NonNullable<ContextEstimate['glossary']>;

/** Досье и глоссарий заготовки и строки оценки тех, что строятся первыми. */
interface DraftContext {
  run: { dossierId: string; glossaryId: string | null } | null;
  dossier: BookDossier | null;
  glossaryData: unknown;
  dossierLine: ContextLine | null;
  glossaryLine: ContextLine | null;
}

interface Estimate {
  dto: ContentDraftEstimateDto;
  suggestedLimitUsd: Prisma.Decimal;
  /** Лимит досье или глоссария, которые строятся первыми: лимит заготовки не может быть меньше. */
  contextLimitUsd: Prisma.Decimal;
  /** Досье и глоссарий запуска переведённой версии (Р18): заготовка привязывается к ним сразу. */
  run: { dossierId: string; glossaryId: string | null } | null;
  language: Language;
}

/**
 * Заготовка Summary из досье (`F05-10`; `product.md` §5.1-5.2, `tech.md` §2б): разделы по плану
 * досье, полный - из сохранённых разделов, очень краткий - из сохранённого полного. Строится
 * фоном под своей операцией `draft`; в `BookSummary` и `BookSummarySection` не пишет - черновик
 * сохраняет редактор существующими ручками.
 */
@Injectable()
export class ContentDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierService,
  ) {}

  async estimate(versionId: string, kind: ContentDraftKind): Promise<ContentDraftEstimateDto> {
    return (await this.estimateOf(versionId, kind)).dto;
  }

  async start(
    versionId: string,
    kind: ContentDraftKind,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string,
  ): Promise<ContentDraftDto> {
    this.llm.assertEnabled();
    const estimate = await this.estimateOf(versionId, kind);
    // Потолок исчерпан - отказ без операции и без строки (В11 `F05-2`, В2 `F05-10`).
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const limit = limitUsd ?? estimate.suggestedLimitUsd;
    // Досье и глоссарий ждут в остатке лимита заготовки (С12, В9).
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
    });
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        // Прежняя готовая или упавшая заготовка того же вида уступает новой (В7).
        await tx.contentDraft.updateMany({
          where: { bookVersionId: versionId, kind, status: { in: ['ready', 'failed'] } },
          data: { status: 'discarded' },
        });
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.contentDraft.create({
          data: {
            bookVersionId: versionId,
            kind,
            language: estimate.language,
            operationId: op.id,
            dossierId: estimate.run?.dossierId ?? null,
            glossaryId: estimate.run?.glossaryId ?? null,
          },
        });
        await this.tasks.enqueue(draftTaskInput(row), tx);
        return row.id;
      }, DRAFT_TX_OPTIONS);
    } catch (error) {
      // Одна строящаяся на пару (версия, вид) - частичным уникальным индексом, а не чтением (L-019).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw llmTaskConflict(DRAFT_IN_PROGRESS, 'A draft of this kind is already being built');
      }
      throw error;
    }
    return this.get(id);
  }

  /** Последняя неотброшенная заготовка вида в любом статусе (В3); нет - `null`. */
  async latest(versionId: string, kind: ContentDraftKind): Promise<ContentDraftStateDto> {
    const row = await this.prisma.contentDraft.findFirst({
      where: { bookVersionId: versionId, kind, status: { not: 'discarded' } },
      include: { operation: true },
      orderBy: { createdAt: 'desc' },
    });
    return { draft: row ? await this.toDto(row) : null };
  }

  /**
   * «Не нужна»: строящаяся - отмена её операции и `discarded` одной транзакцией (В10), готовая
   * и упавшая - только статус. Досье и глоссарий своих операций не отменяются.
   */
  async discard(id: string): Promise<ContentDraftDto> {
    const row = await this.prisma.contentDraft.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Content draft not found');
    if (row.status === 'building') {
      await this.tasks.cancelOperation(row.operationId, async (tx) => {
        await tx.contentDraft.updateMany({
          where: { id, status: 'building' },
          data: { status: 'discarded' },
        });
      });
    }
    // Операция уже кончилась (заготовка успела стать готовой) или строка не строилась.
    await this.prisma.contentDraft.updateMany({
      where: { id, status: { not: 'discarded' } },
      data: { status: 'discarded' },
    });
    return this.get(id);
  }

  /**
   * Раздел заготовки добавлен редактором (Р1): номер дописывается одним условным UPDATE по jsonb,
   * без чтения и записи следом (L-019); повтор ничего не меняет. Не `ready` - 409, номера нет
   * среди разделов - 400.
   */
  async markSectionAdded(id: string, number: number): Promise<ContentDraftDto> {
    const row = await this.prisma.contentDraft.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Content draft not found');
    if (row.status !== 'ready' || row.kind !== 'summary_sections') {
      throw llmTaskConflict(DRAFT_NOT_READY, 'Only a ready sections draft takes added marks');
    }
    const sections = ((row.data ?? {}) as DraftData).sections ?? [];
    if (!sections.some((s) => s.number === number)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `The draft has no section ${number}`,
        code: DRAFT_SECTION_UNKNOWN,
      });
    }
    const mark = JSON.stringify([number]);
    const changed = await this.prisma.$executeRaw`
      UPDATE "ContentDraft"
      SET "data" = jsonb_set(
            "data",
            '{addedSections}',
            COALESCE("data"->'addedSections', '[]'::jsonb) || ${mark}::jsonb
          ),
          "updatedAt" = ${utcTimestamp(new Date())}
      WHERE "id" = ${id}
        AND "status" = 'ready'
        AND NOT (COALESCE("data"->'addedSections', '[]'::jsonb) @> ${mark}::jsonb)`;
    // Ноль строк - номер уже отмечен (повтор) или заготовку отбросили между чтением и записью.
    if (changed === 0) {
      const current = await this.prisma.contentDraft.findUnique({ where: { id } });
      if (current?.status !== 'ready') {
        throw llmTaskConflict(DRAFT_NOT_READY, 'Only a ready sections draft takes added marks');
      }
    }
    return this.get(id);
  }

  async get(id: string): Promise<ContentDraftDto> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!row) throw new NotFoundException('Content draft not found');
    return this.toDto(row);
  }

  /** Сохранённые разделы версии с видимым текстом, по номеру (В4); текст - абзацами. */
  async savedSections(versionId: string): Promise<Array<{ title: string; text: string }>> {
    const rows = await this.prisma.bookSummarySection.findMany({
      where: { bookVersionId: versionId },
      select: { title: true, text: true },
      orderBy: { number: 'asc' },
      take: SUMMARY_SECTION_LIMITS.sectionsPerVersion,
    });
    // Видимый текст - по тому же разбору, что уходит в промпт: раздел из одной картинки
    // «сохранённым» не считается (В4).
    return rows
      .map((r) => ({ title: r.title, text: htmlToParagraphs(r.text) }))
      .filter((r) => r.text !== '');
  }

  /** Сохранённый полный пересказ с видимым текстом абзацами; нет - `null` (В4). */
  async savedFull(versionId: string): Promise<string | null> {
    const row = await this.prisma.bookSummary.findUnique({
      where: { bookVersionId: versionId },
      select: { summary: true },
    });
    const text = row ? htmlToParagraphs(row.summary) : '';
    return text === '' ? null : text;
  }

  async languageOf(versionId: string): Promise<Language | null> {
    const row = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true },
    });
    return row?.language ?? null;
  }

  /** Главы версии с видимым текстом по номеру; глав больше потолка досье не бывает. */
  async versionChapters(
    versionId: string,
  ): Promise<Array<{ number: number; title: string; content: string }>> {
    const chapters = await this.prisma.chapter.findMany({
      where: { bookVersionId: versionId },
      select: { number: true, title: true, content: true },
      orderBy: { number: 'asc' },
      take: DOSSIER_MAX_CHAPTERS,
    });
    return chapters.filter((c) => htmlToParagraphs(c.content) !== '');
  }

  /**
   * Сохранённый анализ версии - только чтение, чистыми помощниками модуля анализа (Р13): у
   * фонового шага нет участника запроса, а `BookAnalysisService` проверяет его роль и гео.
   */
  async storedAnalysis(
    versionId: string,
  ): Promise<{ stored: StoredBookAnalysis; updatedAt: string | null }> {
    const row = await this.prisma.bookAnalysis.findUnique({
      where: { bookVersionId: versionId },
      select: BOOK_ANALYSIS_SELECT,
    });
    return {
      stored: readStoredAnalysis(row ?? {}),
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------

  private async toDto(row: ContentDraft & { operation: LlmOperation }): Promise<ContentDraftDto> {
    const data = (row.data ?? {}) as DraftData;
    let waitingFor: ContentDraftDto['waitingFor'] = null;
    if (row.waitingFor && row.status === 'building') {
      const glossary = await this.prisma.bookGlossary.findUnique({
        where: { id: row.waitingFor },
        select: { id: true },
      });
      waitingFor = glossary ? 'glossary' : 'dossier';
    }
    return {
      id: row.id,
      bookVersionId: row.bookVersionId,
      kind: row.kind,
      status: row.status,
      language: row.language,
      failedReason: row.failedReason,
      waitingFor,
      operation: toOperationDto(row.operation),
      model: row.model,
      plannedSections: data.plannedSections ?? null,
      sections: row.kind === 'summary_sections' ? (data.sections ?? []) : null,
      addedSections: data.addedSections ?? [],
      text: data.text ?? null,
      question: data.question ?? null,
      analysis: data.analysis ?? null,
      droppedQuotes: row.kind === 'analysis' ? (data.droppedQuotes ?? []) : null,
      motifs: row.kind === 'analysis' ? (data.motifs ?? []) : null,
      dossierLanguage: data.dossierLanguage ?? null,
      analysisUpdatedAt: data.analysisUpdatedAt ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async estimateOf(versionId: string, kind: ContentDraftKind): Promise<Estimate> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true, title: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    if (kind === 'summary_sections') return this.sectionsEstimate(versionId, version);
    if (kind === 'analysis') return this.analysisEstimate(versionId, version);

    const call = await stageEstimatorFor(this.llm, DRAFT_STAGE_BY_KIND[kind]);
    let usd: Prisma.Decimal;
    if (kind === 'summary_full') {
      const sections = await this.savedSections(versionId);
      if (sections.length === 0) {
        throw llmTaskConflict(
          SUMMARY_SECTIONS_MISSING,
          'Save at least one summary section with text first',
        );
      }
      usd = call.estimate(
        summaryFullRequest({ bookTitle: version.title, language: version.language, sections }),
      );
    } else {
      const full = await this.savedFull(versionId);
      if (full === null) {
        throw llmTaskConflict(SUMMARY_FULL_MISSING, 'Save the full summary with text first');
      }
      usd = call.estimate(
        summaryBriefRequest({
          bookTitle: version.title,
          language: version.language,
          fullText: full,
        }),
      );
    }
    const suggested = usd.mul(DRAFT_LIMIT_FACTOR);
    return {
      suggestedLimitUsd: suggested,
      contextLimitUsd: new Prisma.Decimal(0),
      run: null,
      language: version.language,
      dto: {
        kind,
        dossier: null,
        glossary: null,
        sections: null,
        stageUsd: moneyUsd(usd),
        upperBound: false,
        suggestedLimitUsd: moneyUsd(suggested),
      },
    };
  }

  /**
   * Досье и глоссарий заготовки - общие для разделов и анализа (решение арбитра `F05 | F05-11`,
   * Р14): у переведённой версии - досье и глоссарий запуска (Р18, без свежести), иначе
   * действующее поколение досье исходника - устаревшее даёт 409 `DOSSIER_STALE`, отсутствующее
   * строится первым строкой оценки (Р5). Глоссарий не нужен на языке досье (В6).
   */
  private async draftContext(
    versionId: string,
    version: { language: Language },
  ): Promise<DraftContext> {
    const run = await this.dossiers.finishedRunContextOf(versionId);
    if (run) {
      if (!run.dossier || run.dossier.status !== 'ready') {
        throw llmTaskConflict(
          DRAFT_DOSSIER_MISSING,
          'The dossier of the translation run that made this version is gone',
        );
      }
      let glossaryData: unknown = null;
      if (run.glossaryId) {
        const glossary = await this.prisma.bookGlossary.findUnique({
          where: { id: run.glossaryId },
          select: { data: true },
        });
        glossaryData = glossary?.data ?? null;
      }
      return {
        run: { dossierId: run.dossier.id, glossaryId: run.glossaryId },
        dossier: run.dossier,
        glossaryData,
        dossierLine: null,
        glossaryLine: null,
      };
    }
    const status = await this.dossiers.status(versionId);
    if (status.status === 'ready' && status.fresh === false) {
      throw llmTaskConflict(
        DOSSIER_STALE,
        'The source changed after the dossier was built: rebuild the dossier',
      );
    }
    const sourceLanguage = await this.languageOf(status.sourceVersionId);
    const needsGlossary = sourceLanguage !== version.language;
    const context = await this.dossiers.contextEstimate(versionId, version.language);
    const glossaryLine = needsGlossary ? context.glossary : null;
    const dossier =
      status.status === 'ready' ? await this.dossiers.latestDossier(status.sourceVersionId) : null;
    let glossaryData: unknown = null;
    if (dossier && needsGlossary && glossaryLine === null) {
      const glossary = await this.prisma.bookGlossary.findUnique({
        where: { dossierId_language: { dossierId: dossier.id, language: version.language } },
        select: { data: true, status: true },
      });
      glossaryData = glossary?.status === 'ready' ? glossary.data : null;
    }
    return {
      run: null,
      dossier,
      glossaryData,
      dossierLine: context.dossier ? { ...context.dossier, upperBound: false } : null,
      glossaryLine,
    };
  }

  /**
   * Оценка заготовки поверх контекста: лимит - max(этап × 1,5, лимиты досье и глоссария,
   * которые строятся первыми) (В9, Р4).
   */
  private withContext(
    kind: ContentDraftKind,
    context: DraftContext,
    stage: { usd: Prisma.Decimal; upperBound: boolean },
    sections: number | null,
    language: Language,
    retries = 0,
  ): Estimate {
    const maxOf = (values: Array<Prisma.Decimal | undefined>) =>
      values.reduce<Prisma.Decimal>((max, v) => (v && v.gt(max) ? v : max), new Prisma.Decimal(0));
    const contextLimitUsd = maxOf([
      context.dossierLine?.suggestedLimitUsd,
      context.glossaryLine?.suggestedLimitUsd,
    ]);
    // Повторы с замечанием платятся целиком (Р28): лимит по умолчанию закладывает и их.
    const suggested = maxOf([stage.usd.mul(1 + retries).mul(DRAFT_LIMIT_FACTOR), contextLimitUsd]);
    const line = (l: ContextLine | null) =>
      l
        ? {
            estimateUsd: moneyUsd(l.estimateUsd),
            suggestedLimitUsd: moneyUsd(l.suggestedLimitUsd),
            upperBound: l.upperBound,
          }
        : null;
    return {
      suggestedLimitUsd: suggested,
      contextLimitUsd,
      language,
      run: context.run,
      dto: {
        kind,
        dossier: line(context.dossierLine),
        glossary: line(context.glossaryLine),
        sections,
        stageUsd: moneyUsd(stage.usd),
        upperBound: stage.upperBound,
        suggestedLimitUsd: moneyUsd(suggested),
      },
    };
  }

  private async sectionsEstimate(
    versionId: string,
    version: { language: Language; title: string },
  ): Promise<Estimate> {
    const call = await stageEstimatorFor(this.llm, SUMMARY_SECTIONS_STAGE);
    const context = await this.draftContext(versionId, version);
    const plan = context.dossier ? summaryPlanOf(context.dossier.data) : [];
    const stage = await this.sectionsStageUsd(
      versionId,
      version,
      call,
      context.dossier,
      context.glossaryData,
      plan,
    );
    return this.withContext(
      'summary_sections',
      context,
      stage,
      stage.upperBound ? null : plan.length,
      version.language,
    );
  }

  /**
   * Анализ (`F05-11`): один вызов на весь текст версии с досье, глоссарием и сохранённым
   * анализом (Р8). Досье ещё нет - сверху: размер досье и глоссария по ответу их этапов.
   */
  private async analysisEstimate(
    versionId: string,
    version: { language: Language; title: string },
  ): Promise<Estimate> {
    const call = await stageEstimatorFor(this.llm, ANALYSIS_DRAFT_STAGE);
    const chapters = await this.versionChapters(versionId);
    // Без текста глав анализу не из чего строиться: отказ до досье и глоссария (Р26).
    if (chapters.length === 0) {
      throw llmTaskConflict('SOURCE_HAS_NO_CHAPTERS', 'The version has no chapter text');
    }
    const context = await this.draftContext(versionId, version);
    // Досье или глоссарий ещё строятся: их размер во входе - сверху, по ответу их этапов.
    const upperBound = context.dossier === null || context.glossaryLine !== null;
    const extra = upperBound ? await contextUpperChars(this.llm) : 0;
    const { stored } = await this.storedAnalysis(versionId);
    const usd = call.estimate(
      analysisDraftRequest({
        bookTitle: version.title,
        language: version.language,
        dossier: context.dossier?.data ?? null,
        glossary: context.glossaryData,
        stored: draftBlocksOf(stored),
        chaptersText: chaptersText(chapters),
      }),
      extra,
    );
    return this.withContext(
      'analysis',
      context,
      { usd, upperBound },
      null,
      version.language,
      ANALYSIS_DRAFT_REMARKS,
    );
  }

  /**
   * Вызовы разделов: план известен - по разделу на вызов с текстом его глав; досье ещё нет -
   * сверху по главе на раздел с досье и глоссарием по размеру ответа их этапов.
   */
  private async sectionsStageUsd(
    versionId: string,
    version: { language: Language; title: string },
    call: StageCallEstimator,
    dossier: BookDossier | null,
    glossaryData: unknown,
    plan: PlanSection[],
  ): Promise<{ usd: Prisma.Decimal; upperBound: boolean }> {
    const chapters = await this.prisma.chapter.findMany({
      where: { bookVersionId: versionId },
      select: { number: true, title: true, content: true },
      orderBy: { number: 'asc' },
      // Глав больше потолка досье не бывает: досье по такой книге не строится.
      take: DOSSIER_MAX_CHAPTERS,
    });
    const upperBound = plan.length === 0;
    const extra = upperBound ? await contextUpperChars(this.llm) : 0;
    const sections = upperBound
      ? chapters.map((c) => ({ number: c.number, title: c.title, chapters: [c.number] }))
      : plan;
    let usd = new Prisma.Decimal(0);
    for (const section of sections) {
      const own = chapters.filter(
        (c) => section.chapters.includes(c.number) && htmlToParagraphs(c.content) !== '',
      );
      usd = usd.add(
        call.estimate(
          summarySectionRequest({
            bookTitle: version.title,
            language: version.language,
            dossier: dossier?.data ?? null,
            glossary: glossaryData,
            section,
            chaptersText: chaptersText(own),
          }),
          extra,
        ),
      );
    }
    return { usd, upperBound };
  }
}
