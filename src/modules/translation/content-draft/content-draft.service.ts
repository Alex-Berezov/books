import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { BookDossier, ContentDraft, Language, LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import {
  BOOK_ANALYSIS_SELECT,
  readStoredAnalysis,
  StoredBookAnalysis,
} from '../../book-analysis/book-analysis-data';
import { chapterPages } from '../chapter-pages';
import { DOSSIER_TOO_LONG } from '../dossier/dossier.constants';
import { ContextEstimate, DossierDemandService } from '../dossier/dossier-demand.service';
import { DossierService } from '../dossier/dossier.service';
import { DossierMotifDto } from '../dto/dossier-data.dto';
import {
  ContentDraftDto,
  ContentDraftEstimateDto,
  ContentDraftStateDto,
} from '../dto/content-draft-response.dto';
import { stageEstimatorFor } from '../llm-model-checks';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  CONTENT_DRAFT_KINDS,
  CONTENT_DRAFT_TASK_KIND,
  DOSSIER_STALE,
  DRAFT_DOSSIER_MISSING,
  DRAFT_IN_PROGRESS,
  DRAFT_LIMIT_FACTOR,
  DRAFT_LIMIT_TOO_LOW,
  DRAFT_TOO_LONG,
  DRAFT_TX_OPTIONS,
  ANALYSIS_DRAFT_REMARKS,
  ANALYSIS_DRAFT_STAGE,
  DraftKind,
  RETIRED_SUMMARY_DRAFT_KINDS,
} from './content-draft.constants';
import { AnalysisDraftJson, draftBlocksOf, DroppedQuote } from './content-draft.analysis';
import { analysisDraftRequest } from './content-draft.prompts';
import type { RunKind } from '../draft-quality/run-regen';
import { chaptersText, htmlToParagraphs } from './content-draft.text';

/** Данные заготовки Analysis в `ContentDraft.data`. */
export interface DraftData {
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

type ContextLine = NonNullable<ContextEstimate['glossary']>;
type DossierLine = NonNullable<ContextEstimate['dossier']>;

/** Досье и глоссарий заготовки и строки оценки тех, что строятся первыми. */
export interface DraftContext {
  run: { dossierId: string; glossaryId: string | null } | null;
  dossier: BookDossier | null;
  glossaryData: unknown;
  dossierLine: (ContextLine & Pick<DossierLine, 'refusedTooLong'>) | null;
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
 * Лимит поверх контекста (В9, Р4 `F05-10`): max(вызовы × 1,5, лимиты досье и глоссария, которые
 * строятся первыми), и строки досье и глоссария для ответа оценки. Одно правило на заготовки и
 * ход пересказа `F06-2`. Повторы с замечанием (Р28) вызывающий закладывает в `stageUsd`.
 */
export function contextLimits(context: DraftContext, stageUsd: Prisma.Decimal) {
  const maxOf = (values: Array<Prisma.Decimal | undefined>) =>
    values.reduce<Prisma.Decimal>((max, v) => (v && v.gt(max) ? v : max), new Prisma.Decimal(0));
  const contextLimitUsd = maxOf([
    context.dossierLine?.suggestedLimitUsd,
    context.glossaryLine?.suggestedLimitUsd,
  ]);
  const suggestedLimitUsd = maxOf([stageUsd.mul(DRAFT_LIMIT_FACTOR), contextLimitUsd]);
  const line = (l: ContextLine) => ({
    estimateUsd: moneyUsd(l.estimateUsd),
    suggestedLimitUsd: moneyUsd(l.suggestedLimitUsd),
    upperBound: l.upperBound,
  });
  const { dossierLine, glossaryLine } = context;
  return {
    suggestedLimitUsd,
    contextLimitUsd,
    dossier: dossierLine
      ? { ...line(dossierLine), refusedTooLong: dossierLine.refusedTooLong }
      : null,
    glossary: glossaryLine ? line(glossaryLine) : null,
  };
}

/**
 * Строка вида, который принимают ручки заготовок (`CONTENT_DRAFT_KINDS`): ход пересказа
 * `summary_write` (`F06`) и снятые пошаговые виды Summary ручками заготовок не читаются и не
 * отбрасываются - 404 (решения арбитра `F06 | F06-1`, В2; `F06 | F06-3`, А2).
 */
const isDraftKind = (kind: string): kind is DraftKind =>
  (CONTENT_DRAFT_KINDS as readonly string[]).includes(kind);

/** Сколько строк снятых видов дренаж отбрасывает за одну выборку (`findMany` с пределом). */
const RETIRED_DRAIN_BATCH = 100;

/**
 * Заготовка Analysis из досье (`F05-11`): строится фоном под своей операцией `draft`; в анализ
 * версии не пишет - черновик сохраняет редактор. Пошаговые заготовки Summary `F05-10` сняты
 * в `F06-3` (их заменил ход `summary_write`): при старте строящиеся отбрасываются (А1).
 */
@Injectable()
export class ContentDraftService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContentDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierService,
    private readonly dossierDemand: DossierDemandService,
  ) {}

  /**
   * Дренаж снятых видов при старте (решение арбитра `F06 | F06-3`, А1): сбой не роняет старт -
   * строку, чья задача придёт к обработчику, отбросит тот же путь (`discardRetired`).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const drained = await this.drainRetiredSummaryDrafts();
      if (drained > 0) this.logger.log(`Retired summary drafts discarded: ${drained}`);
    } catch (error) {
      this.logger.error(
        `Retired summary drafts were not drained: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Строящиеся заготовки снятых видов Summary - `discarded`, их операции `cancelled`, `pending`-
   * задачи `cancelled` тем же путём, что «Discard draft» (`tech.md` §3, А1). Отбор - по строкам
   * снятых видов и их `operationId`: вид задачи `content_draft` общий с Analysis. Повтор ничего
   * не меняет. Возвращает число отброшенных строк.
   */
  async drainRetiredSummaryDrafts(): Promise<number> {
    let drained = 0;
    for (;;) {
      const rows = await this.prisma.contentDraft.findMany({
        where: { kind: { in: [...RETIRED_SUMMARY_DRAFT_KINDS] }, status: 'building' },
        select: { id: true, operationId: true },
        orderBy: { createdAt: 'asc' },
        take: RETIRED_DRAIN_BATCH,
      });
      for (const row of rows) await this.discardRetired(row);
      drained += rows.length;
      if (rows.length < RETIRED_DRAIN_BATCH) return drained;
    }
  }

  /** Строящаяся строка снятого вида - `discarded` с отменой её операции (А1). */
  async discardRetired(row: { id: string; operationId: string }): Promise<void> {
    await this.dropRow(row.id, row.operationId, true);
  }

  async estimate(versionId: string, kind: DraftKind): Promise<ContentDraftEstimateDto> {
    return (await this.estimateOf(versionId, kind)).dto;
  }

  async start(
    versionId: string,
    kind: DraftKind,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string,
  ): Promise<ContentDraftDto> {
    this.llm.assertEnabled();
    const estimate = await this.estimateOf(versionId, kind);
    // Досье заведомо откажет `DOSSIER_TOO_LONG` (то же правило, что у старта досье): операция
    // и строка не заводятся, прежняя заготовка не теряется (`LEGACY-477`, `T153`).
    if (estimate.dto.dossier?.refusedTooLong) {
      throw llmTaskConflict(
        DOSSIER_TOO_LONG,
        'The dossier summary is too long for the stage model',
      );
    }
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
  async latest(versionId: string, kind: DraftKind): Promise<ContentDraftStateDto> {
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
    if (!row || !isDraftKind(row.kind)) throw new NotFoundException('Content draft not found');
    await this.dropRow(id, row.operationId, row.status === 'building');
    return this.get(id);
  }

  /**
   * Вид хода для общих ручек `content-drafts/:id/*` (`F07-1b`, решение арбитра `F07 | F07-1`, В6):
   * одна выборка строки; нет строки или вид не ход (заготовка, снятый вид) - 404.
   */
  async runKindOf(id: string): Promise<RunKind> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      select: { kind: true },
    });
    if (row?.kind !== 'summary_write' && row?.kind !== 'analysis_write') {
      throw new NotFoundException('Run not found');
    }
    return row.kind;
  }

  /** Строящаяся - отмена операции и `discarded` одной транзакцией (В10), иначе только статус. */
  private async dropRow(id: string, operationId: string, building: boolean): Promise<void> {
    if (building) {
      await this.tasks.cancelOperation(operationId, async (tx) => {
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
  }

  async get(id: string): Promise<ContentDraftDto> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!row || !isDraftKind(row.kind)) throw new NotFoundException('Content draft not found');
    return this.toDto(row);
  }

  async languageOf(versionId: string): Promise<Language | null> {
    const row = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true },
    });
    return row?.language ?? null;
  }

  /**
   * Главы версии с видимым текстом по номеру - страницами (`F05-Rb`) и не дальше входа, который
   * влезет в вызов анализа: текст копится, пока не перешёл `stageInputCeiling` этапа, дальше
   * `null` (`DRAFT_TOO_LONG`) без чтения остатка. Усечённого текста не бывает (решение арбитра
   * `F05 | F05-Rb`, Р2). Контекст моделей неизвестен - читается вся книга, решает провайдер.
   */
  async versionChapters(
    versionId: string,
  ): Promise<Array<{ number: number; title: string; content: string }> | null> {
    const { maxInputChars } = await this.llm.stageInputCeiling(ANALYSIS_DRAFT_STAGE);
    const chapters: Array<{ number: number; title: string; content: string }> = [];
    let chars = 0;
    for await (const page of chapterPages(this.prisma, versionId, {
      number: true,
      title: true,
      content: true,
    })) {
      for (const chapter of page) {
        const text = htmlToParagraphs(chapter.content);
        if (text === '') continue;
        chars += text.length;
        if (maxInputChars !== null && chars > maxInputChars) return null;
        chapters.push(chapter);
      }
    }
    return chapters;
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
    // Ответ заготовки несёт только прежние виды (В2): строка хода наружу этим путём не уходит.
    if (!isDraftKind(row.kind)) throw new NotFoundException('Content draft not found');
    const kind = row.kind;
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
      kind,
      status: row.status,
      language: row.language,
      failedReason: row.failedReason,
      waitingFor,
      operation: toOperationDto(row.operation),
      model: row.model,
      analysis: data.analysis ?? null,
      droppedQuotes: data.droppedQuotes ?? [],
      motifs: data.motifs ?? [],
      dossierLanguage: data.dossierLanguage ?? null,
      analysisUpdatedAt: data.analysisUpdatedAt ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async estimateOf(versionId: string, kind: DraftKind): Promise<Estimate> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true, title: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    return this.analysisEstimate(versionId, version, kind);
  }

  /**
   * Досье и глоссарий заготовки - общие для анализа и хода пересказа (решение арбитра `F05 | F05-11`,
   * Р14): у переведённой версии - досье и глоссарий запуска (Р18, без свежести), иначе
   * действующее поколение досье исходника - устаревшее даёт 409 `DOSSIER_STALE`, отсутствующее
   * строится первым строкой оценки (Р5). Глоссарий не нужен на языке досье (В6).
   */
  async draftContext(versionId: string, version: { language: Language }): Promise<DraftContext> {
    const run = await this.dossierDemand.finishedRunContextOf(versionId);
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
    const context = await this.dossierDemand.contextEstimate(versionId, version.language);
    const glossaryLine = needsGlossary ? context.glossary : null;
    const dossier =
      status.status === 'ready'
        ? await this.dossierDemand.latestDossier(status.sourceVersionId)
        : null;
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
    kind: DraftKind,
    context: DraftContext,
    stage: { usd: Prisma.Decimal; upperBound: boolean },
    language: Language,
    retries = 0,
  ): Estimate {
    const lines = contextLimits(context, stage.usd.mul(1 + retries));
    return {
      suggestedLimitUsd: lines.suggestedLimitUsd,
      contextLimitUsd: lines.contextLimitUsd,
      language,
      run: context.run,
      dto: {
        kind,
        dossier: lines.dossier,
        glossary: lines.glossary,
        stageUsd: moneyUsd(stage.usd),
        upperBound: stage.upperBound,
        suggestedLimitUsd: moneyUsd(lines.suggestedLimitUsd),
      },
    };
  }

  /**
   * Анализ (`F05-11`): один вызов на весь текст версии с досье, глоссарием и сохранённым
   * анализом (Р8). Досье ещё нет - сверху: размер досье и глоссария по ответу их этапов.
   */
  private async analysisEstimate(
    versionId: string,
    version: { language: Language; title: string },
    kind: DraftKind,
  ): Promise<Estimate> {
    const call = await stageEstimatorFor(this.llm, ANALYSIS_DRAFT_STAGE);
    const chapters = await this.versionChapters(versionId);
    // Текст сам не влезает в вызов: сумму по части книги оценка не считает (Р2 `F05-Rb`).
    if (chapters === null) {
      throw llmTaskConflict(
        DRAFT_TOO_LONG,
        'The version text does not fit the context of the analysis model',
      );
    }
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
      kind,
      context,
      { usd, upperBound },
      version.language,
      ANALYSIS_DRAFT_REMARKS,
    );
  }
}
