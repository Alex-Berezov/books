import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentDraft, LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BOOK_ANALYSIS_TX_OPTIONS, lockBookAnalysis } from '../../book-analysis/book-analysis-lock';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { allChapters } from '../chapter-pages';
import { DRAFT_IN_PROGRESS, DRAFT_LIMIT_TOO_LOW } from '../content-draft/content-draft.constants';
import { ContentDraftService, contextLimits } from '../content-draft/content-draft.service';
import { htmlToParagraphs } from '../content-draft/content-draft.text';
import { DOSSIER_TOO_LONG } from '../dossier/dossier.constants';
import {
  AnalysisWriteDto,
  AnalysisWriteEstimateDto,
  AnalysisWriteStateDto,
} from '../dto/analysis-write-response.dto';
import {
  ANALYSIS_REMARK_CODES,
  AnalysisRemarkCode,
  DraftRemark,
} from '../draft-quality/text-checks';
import { stageEstimatorFor } from '../llm-model-checks';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  ANALYSIS_CAST_WRITE_STAGE,
  ANALYSIS_MEANING_WRITE_STAGE,
  ANALYSIS_QUOTES_WRITE_STAGE,
  ANALYSIS_REVIEW_STAGE,
  ANALYSIS_STEPS,
} from './analysis-write.constants';
import {
  analysisDataJson,
  AnalysisItem,
  ANALYSIS_TARGETS,
  emptyAnalysisData,
  readAnalysisData,
} from './analysis-write.data';
import { AnalysisWriteFields } from './analysis-write.fields';
import { analysisWriteTaskInput } from './analysis-write.handler';
import { AnalysisEstimators, analysisPipelineUsd } from './analysis-write.steps';

const KIND = 'analysis_write' as const;

/** Оценщики этапов хода анализа - общие у оценки ручного старта и будущей оценки запуска. */
async function analysisEstimators(llm: LlmService): Promise<AnalysisEstimators> {
  const [cast, quotes, meaning, review] = await Promise.all([
    stageEstimatorFor(llm, ANALYSIS_CAST_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_QUOTES_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_MEANING_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_REVIEW_STAGE),
  ]);
  return { cast, quotes, meaning, review };
}

/**
 * Ход анализа «Write Analysis» (`F07-1a`; `features/F07-analysis-autofill/tech.md` §5-§6): оценка
 * шагов 1-3, старт с правом хода на блоки под замком анализа и чтение хода. Контекст досье и
 * глоссария и отказы старта - те же, что у хода пересказа и заготовок (`draftContext`).
 * «Accept», «Discard», «Regenerate», «Continue» - `F07-1b`.
 */
@Injectable()
export class AnalysisWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly drafts: ContentDraftService,
    private readonly fields: AnalysisWriteFields,
  ) {}

  async estimate(versionId: string): Promise<AnalysisWriteEstimateDto> {
    return (await this.estimateOf(versionId)).dto;
  }

  /**
   * Ручной старт: прежний готовый или упавший ход отбрасывается; право хода на блоки - под замком
   * анализа в одной транзакции со строкой хода (`tech.md` §5). Один строящийся ход вида на версию -
   * частичным уникальным индексом (`DRAFT_IN_PROGRESS`).
   */
  async start(
    versionId: string,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string | null,
  ): Promise<AnalysisWriteDto> {
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
      translationRunId: null,
    });
    let id: string;
    try {
      // Ожидание замка анализа идёт в дедлайн транзакции (`L-020`): сроки - те же, что у прочих
      // писателей под этим замком, а не короткие сроки строки заготовки.
      id = await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, versionId);
        await tx.contentDraft.updateMany({
          where: { bookVersionId: versionId, kind: KIND, status: { in: ['ready', 'failed'] } },
          data: { status: 'discarded' },
        });
        const { owns, written } = await this.fields.ownership(tx, versionId);
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.contentDraft.create({
          data: {
            bookVersionId: versionId,
            kind: KIND,
            language: estimate.language,
            operationId: op.id,
            dossierId: estimate.run?.dossierId ?? null,
            glossaryId: estimate.run?.glossaryId ?? null,
            data: analysisDataJson(emptyAnalysisData(owns, written)),
          },
        });
        await this.tasks.enqueue(analysisWriteTaskInput(row, op.id), tx);
        return row.id;
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw llmTaskConflict(DRAFT_IN_PROGRESS, 'An analysis run is already being built');
      }
      throw error;
    }
    return this.get(id);
  }

  async latest(versionId: string): Promise<AnalysisWriteStateDto> {
    const row = await this.prisma.contentDraft.findFirst({
      where: { bookVersionId: versionId, kind: KIND, status: { not: 'discarded' } },
      include: { operation: true },
      orderBy: { createdAt: 'desc' },
    });
    return { draft: row ? await this.toDto(row) : null };
  }

  async get(id: string): Promise<AnalysisWriteDto> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!row || row.kind !== KIND) throw new NotFoundException('Analysis run not found');
    return this.toDto(row);
  }

  /**
   * Оценка шагов 1-3 (`tech.md` §6) по главам версии; досье или глоссария ещё нет - вход сверху
   * потолком их этапов. Версия без текста глав - отказ до досье.
   */
  private async estimateOf(versionId: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true, title: true, author: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    const chapters = (
      await allChapters(this.prisma, versionId, { number: true, title: true, content: true })
    ).filter((c) => htmlToParagraphs(c.content) !== '');
    if (chapters.length === 0) {
      throw llmTaskConflict('SOURCE_HAS_NO_CHAPTERS', 'The version has no chapter text');
    }
    const calls = await analysisEstimators(this.llm);
    const context = await this.drafts.draftContext(versionId, version);
    const state = await this.fields.state(this.prisma, versionId);
    const upperBound = context.dossier === null || context.glossaryLine !== null;
    const extra = upperBound ? await contextUpperChars(this.llm) : 0;
    const usd = analysisPipelineUsd(
      calls,
      {
        language: version.language,
        dossier: context.dossier?.data ?? null,
        glossary: context.glossaryData,
        bookTitle: version.title,
        author: version.author,
        stored: state.stored,
        merged: {},
        chapters,
        otherKeys: '',
      },
      extra,
    );
    const lines = contextLimits(context, usd);
    return {
      suggestedLimitUsd: lines.suggestedLimitUsd,
      contextLimitUsd: lines.contextLimitUsd,
      run: context.run,
      language: version.language,
      dto: {
        dossier: lines.dossier,
        glossary: lines.glossary,
        stageUsd: moneyUsd(usd),
        upperBound,
        suggestedLimitUsd: moneyUsd(lines.suggestedLimitUsd),
      } satisfies AnalysisWriteEstimateDto,
    };
  }

  private async toDto(row: ContentDraft & { operation: LlmOperation }): Promise<AnalysisWriteDto> {
    const data = readAnalysisData(row.data);
    let waitingFor: AnalysisWriteDto['waitingFor'] = null;
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
      status: row.status,
      language: row.language,
      failedReason: row.failedReason,
      waitingFor,
      operation: toOperationDto(row.operation),
      stepsTotal: ANALYSIS_STEPS,
      owns: ANALYSIS_TARGETS.filter((t) => data.owns[t] === true),
      steps: data.steps.map((s) => ({
        ...s,
        remarks: remarksDto(s.remarks),
        review: reviewDto(s.review),
      })),
      items: data.items.map((item, index) => itemDto(item, index)),
      droppedQuotes: data.droppedQuotes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

const ANALYSIS_CODES = new Set<string>(ANALYSIS_REMARK_CODES);

/**
 * Замечания в ответ - по перечню кодов хода анализа (А4). Чужой код ход не ставит (полноту
 * перечня держит `analysis-checks.spec.ts`); попади он в данные - в ответ он не идёт, контракт
 * не нарушается.
 */
function remarksDto(remarks: readonly DraftRemark[]) {
  return remarks.filter((r): r is DraftRemark & { code: AnalysisRemarkCode } =>
    ANALYSIS_CODES.has(r.code),
  );
}

function reviewDto(review: AnalysisItem['review']) {
  return review
    ? { kind: review.kind, model: review.kind === 'answered' ? review.model : null }
    : null;
}

function itemDto(item: AnalysisItem, index: number): AnalysisWriteDto['items'][number] {
  return {
    index,
    target: item.target,
    step: item.step,
    verdict: item.verdict,
    remarks: remarksDto(item.remarks),
    review: reviewDto(item.review),
    outcome: item.outcome,
    failedReason: item.failedReason,
    links: item.links,
  };
}
