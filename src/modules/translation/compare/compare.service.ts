import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginatedResult, paginated } from '../../../shared/dto/paginated-response.dto';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { splitChapter } from '../chapter-blocks';
import { ContestedWindow, fallbackBoundary, planChunks } from '../chunking/chapter-chunks';
import { DOSSIER_STAGE, GLOSSARY_STAGE } from '../dossier/dossier.constants';
import { DossierService } from '../dossier/dossier.service';
import {
  StartTranslationCompareDto,
  TranslationCompareEstimateQueryDto,
} from '../dto/translation-compare-request.dto';
import {
  TranslationCompareDto,
  TranslationCompareEstimateDto,
  TranslationCompareListItemDto,
} from '../dto/translation-compare-response.dto';
import { TranslationSourceService } from '../translation-source.service';
import {
  SPLIT_STAGE,
  TRANSLATE_STAGE,
  TRANSLATE_TAIL_MAX_CHARS,
} from '../translate/translate.constants';
import { pieceInput } from '../translate/translate-piece';
import { splitRequest, translateRequest } from '../translate/translate.prompts';
import { COMPARE_TASK_KIND, COMPARE_TX_OPTIONS } from './compare.constants';

/** Множитель лимита сравнения по умолчанию - как у досье (`F05-2`, шаг 7). */
const COMPARE_LIMIT_FACTOR = '1.5';

export function chapterFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Задача сравнения: ключ пары «операция:compare» - «продолжить» второй задачи не поставит. */
export function compareTaskInput(
  compareId: string,
  bookVersionId: string,
  language: Language,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: COMPARE_TASK_KIND,
    operationId,
    bookVersionId,
    language,
    payload: { compareId },
    pairKey: `${operationId}:${COMPARE_TASK_KIND}`,
  };
}

interface Estimate {
  dto: TranslationCompareEstimateDto;
  suggestedLimitUsd: Prisma.Decimal;
  chapterContent: string;
  sourceLanguage: Language;
  /** Лимит досье или глоссария, которые строятся первыми: лимит сравнения не может быть меньше. */
  contextLimitUsd: Prisma.Decimal;
}

/**
 * Сравнение моделей перевода на главе (`F05-3`, шаг 3; `product.md` §2.5). Только исходник по D8
 * (С1), язык цели - любой, кроме языка исходника и вне анкеты (С5). Версия не создаётся,
 * находки глоссария не пишутся; досье и глоссарий, если их нет, строятся своими операциями
 * раньше перевода (С2), лимит сравнения обязан их вместить (С12).
 */
@Injectable()
export class TranslationCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly sources: TranslationSourceService,
    private readonly dossiers: DossierService,
  ) {}

  async estimate(
    versionId: string,
    query: TranslationCompareEstimateQueryDto,
  ): Promise<TranslationCompareEstimateDto> {
    return (await this.estimateOf(versionId, query)).dto;
  }

  async start(
    versionId: string,
    dto: StartTranslationCompareDto,
    createdById: string,
  ): Promise<TranslationCompareDto> {
    this.llm.assertEnabled();
    const estimate = await this.estimateOf(versionId, dto);
    // Потолок исчерпан - отказ без операции, как у кнопки досье (С4, В11).
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const limitUsd =
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : estimate.suggestedLimitUsd;
    // Досье и глоссарий ждут в остатке лимита сравнения (С12): меньший лимит заводил бы
    // операцию, которая встаёт на паузу `LIMIT_REACHED` первым же шагом, ничего не сделав.
    if (limitUsd.lt(estimate.contextLimitUsd)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `limitUsd must fit the dossier and glossary built first: at least ${moneyUsd(estimate.contextLimitUsd)}`,
        code: 'COMPARE_LIMIT_TOO_LOW',
      });
    }
    const opData = await this.llm.operationData({
      kind: 'compare',
      bookVersionId: versionId,
      limitUsd,
      createdById,
      models: dto.models,
    });
    const id = await this.prisma.$transaction(async (tx) => {
      const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
      const row = await tx.translationCompare.create({
        data: {
          operationId: op.id,
          bookVersionId: versionId,
          chapterNumber: dto.chapterNumber,
          language: dto.targetLanguage,
          sourceLanguage: estimate.sourceLanguage,
          chapterFingerprint: chapterFingerprint(estimate.chapterContent),
          models: { create: dto.models.map((model, position) => ({ model, position })) },
        },
        select: { id: true },
      });
      await this.tasks.enqueue(compareTaskInput(row.id, versionId, dto.targetLanguage, op.id), tx);
      return row.id;
    }, COMPARE_TX_OPTIONS);
    return this.get(id);
  }

  async get(id: string): Promise<TranslationCompareDto> {
    const row = await this.prisma.translationCompare.findUnique({
      where: { id },
      include: {
        operation: true,
        models: {
          orderBy: { position: 'asc' },
          include: { _count: { select: { chunks: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException('Translation compare not found');
    const [chapter, calls] = await Promise.all([
      this.prisma.chapter.findUnique({
        where: {
          bookVersionId_number: { bookVersionId: row.bookVersionId, number: row.chapterNumber },
        },
        select: { title: true, content: true },
      }),
      // Строк не больше, чем этапов × моделей сравнения: группировка, а не выборка вызовов.
      this.prisma.llmCall.groupBy({
        by: ['stage', 'requestedModel'],
        where: { operationId: row.operationId },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true, durationMs: true },
      }),
    ]);
    const callsOf = (stage: string, model?: string) =>
      calls.filter((c) => c.stage === stage && (model === undefined || c.requestedModel === model));
    const split = callsOf(SPLIT_STAGE);
    const chunks = Array.isArray(row.chunks) ? row.chunks.length : null;
    return {
      ...listItem(row),
      chapterTitle: chapter?.title ?? null,
      originalHtml: chapter?.content ?? null,
      chunks,
      waitingForContext: !row.dossierId || !row.glossaryId,
      splitCostUsd: split.length > 0 ? moneyUsd(sumMoney(split.map((c) => c._sum.costUsd))) : null,
      results: row.models.map((m) => {
        const own = callsOf(TRANSLATE_STAGE, m.model);
        return {
          model: m.model,
          position: m.position,
          status: m.status,
          chunksDone: m._count.chunks,
          html: m.html,
          error: m.error,
          costUsd: moneyUsd(sumMoney(own.map((c) => c._sum.costUsd))),
          inputTokens: own.reduce((s, c) => s + (c._sum.inputTokens ?? 0), 0),
          outputTokens: own.reduce((s, c) => s + (c._sum.outputTokens ?? 0), 0),
          durationMs: own.reduce((s, c) => s + (c._sum.durationMs ?? 0), 0),
        };
      }),
    };
  }

  async list(
    versionId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<TranslationCompareListItemDto>> {
    const where = { bookVersionId: versionId };
    const [rows, total] = await Promise.all([
      this.prisma.translationCompare.findMany({
        where,
        include: {
          operation: true,
          models: { orderBy: { position: 'asc' }, select: { model: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.translationCompare.count({ where }),
    ]);
    return paginated(rows.map(listItem), { page, limit, total });
  }

  // -------------------------------------------------------------------------

  private async estimateOf(
    versionId: string,
    query: TranslationCompareEstimateQueryDto,
  ): Promise<Estimate> {
    const sourceLanguage = await this.assertTarget(versionId, query.targetLanguage);
    const chapter = await this.chapterOf(versionId, query.chapterNumber);
    await this.assertModels(query.models);
    const layout = splitChapter(chapter.content);
    // Переводить нечего (только `hr` и картинки без подписей): колонки вышли бы «готовыми»
    // с исходным текстом.
    if (!layout.blocks.some((b) => b.translatable)) {
      throw llmTaskConflict('COMPARE_CHAPTER_EMPTY', 'The chapter has no text to translate');
    }
    // Спорные стыки по границам кода: каждый - вызов `split` в оценке сверху.
    const windows: ContestedWindow[] = [];
    const chunks = await planChunks(layout, (w) => {
      windows.push(w);
      return Promise.resolve(fallbackBoundary(w));
    });

    const context = await this.dossiers.contextEstimate(versionId, query.targetLanguage);
    const { dossierData, glossaryData } = await this.readyContext(
      context.sourceVersionId,
      query.targetLanguage,
    );
    // Досье или глоссарий ещё не готовы: их вход в переводе - сверху по размеру ответа этапов.
    const upperBound = dossierData === null || glossaryData === null;
    const extra = upperBound ? await this.contextUpperChars() : 0;

    let splitUsd = new Prisma.Decimal(0);
    const split = await this.splitEstimator();
    if (split) {
      for (const w of windows) splitUsd = splitUsd.add(split.estimate(splitRequest(w)));
    }

    const models: Array<{ model: string; estimateUsd: string }> = [];
    let translationsUsd = splitUsd;
    for (const model of query.models) {
      const call = await this.estimator(TRANSLATE_STAGE, model);
      let total = new Prisma.Decimal(0);
      for (let index = 0; index < chunks.length; index++) {
        const request = translateRequest(
          pieceInput({
            layout,
            chunks,
            index,
            dossier: dossierData,
            glossary: glossaryData,
            sourceLanguage,
            targetLanguage: query.targetLanguage,
            chapterNumber: query.chapterNumber,
            previousTail: index > 0 ? 'x'.repeat(TRANSLATE_TAIL_MAX_CHARS) : null,
          }),
        );
        total = total.add(call.estimate(request, extra));
      }
      models.push({ model, estimateUsd: moneyUsd(total) });
      translationsUsd = translationsUsd.add(total);
    }

    // Досье и глоссарий ждут в остатке лимита сравнения (Р20, С12): лимит не меньше их лимитов.
    const maxOf = (values: Array<Prisma.Decimal | undefined>) =>
      values.reduce<Prisma.Decimal>((max, v) => (v && v.gt(max) ? v : max), new Prisma.Decimal(0));
    const contextLimitUsd = maxOf([
      context.dossier?.suggestedLimitUsd,
      context.glossary?.suggestedLimitUsd,
    ]);
    const suggested = maxOf([translationsUsd.mul(COMPARE_LIMIT_FACTOR), contextLimitUsd]);
    return {
      suggestedLimitUsd: suggested,
      contextLimitUsd,
      chapterContent: chapter.content,
      sourceLanguage,
      dto: {
        chapterNumber: query.chapterNumber,
        targetLanguage: query.targetLanguage,
        chunks: chunks.length,
        dossier: context.dossier
          ? {
              estimateUsd: moneyUsd(context.dossier.estimateUsd),
              suggestedLimitUsd: moneyUsd(context.dossier.suggestedLimitUsd),
              upperBound: false,
            }
          : null,
        glossary: context.glossary
          ? {
              estimateUsd: moneyUsd(context.glossary.estimateUsd),
              suggestedLimitUsd: moneyUsd(context.glossary.suggestedLimitUsd),
              upperBound: context.glossary.upperBound,
            }
          : null,
        splitUsd: moneyUsd(splitUsd),
        models,
        upperBound,
        translationsUsd: moneyUsd(translationsUsd),
        suggestedLimitUsd: moneyUsd(suggested),
      },
    };
  }

  /**
   * Версия - исходник по D8 (С1), язык цели - не язык исходника и в анкете (С5); язык, на
   * котором версия уже есть, разрешён: сравнение версию не создаёт. Возвращает язык исходника.
   */
  private async assertTarget(versionId: string, language: Language): Promise<Language> {
    const { source, intakeTargets } = await this.sources.forVersion(versionId);
    // `NO_AVAILABLE_TARGETS` выводится из `VERSION_EXISTS`, а такой язык сравнению открыт.
    if (source.reason && source.reason !== 'NO_AVAILABLE_TARGETS') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'This version cannot be a translation source',
        code: source.reason,
        sourceVersionId: source.sourceVersionId,
      });
    }
    const target = source.targets.find((t) => t.language === language);
    if (target?.reason === 'IS_SOURCE') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'The target language is the language of the source',
        code: 'COMPARE_TARGET_IS_SOURCE',
      });
    }
    // По списку анкеты, а не по причине цели: у языка с версией причина `VERSION_EXISTS`
    // закрывает `NOT_IN_INTAKE`, а сравнение такой язык разрешает (С5).
    if (!intakeTargets?.includes(language)) {
      throw llmTaskConflict('NOT_IN_INTAKE', 'The target language is not in the rights intake');
    }
    return source.sourceLanguage as Language;
  }

  private async chapterOf(
    versionId: string,
    number: number,
  ): Promise<{ title: string; content: string }> {
    const chapter = await this.prisma.chapter.findUnique({
      where: { bookVersionId_number: { bookVersionId: versionId, number } },
      select: { title: true, content: true },
    });
    if (!chapter) throw new NotFoundException('Chapter not found');
    if (chapter.content.trim() === '') {
      throw llmTaskConflict('COMPARE_CHAPTER_EMPTY', 'The chapter has no text');
    }
    return chapter;
  }

  /** Модели сравнения - из каталога OpenRouter (С6); цену проверяет оценщик. */
  private async assertModels(models: readonly string[]): Promise<void> {
    const known = new Set((await this.llm.listModels()).map((m) => m.id));
    const unknown = models.filter((m) => !known.has(m));
    if (unknown.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `Unknown models: ${unknown.join(', ')}`,
        code: 'LLM_MODEL_UNKNOWN',
      });
    }
  }

  private async readyContext(
    sourceVersionId: string,
    language: Language,
  ): Promise<{ dossierData: unknown; glossaryData: unknown }> {
    const dossier = await this.dossiers.latestDossier(sourceVersionId);
    if (dossier?.status !== 'ready') return { dossierData: null, glossaryData: null };
    const glossary = await this.prisma.bookGlossary.findUnique({
      where: { dossierId_language: { dossierId: dossier.id, language } },
      select: { status: true, data: true },
    });
    return {
      dossierData: dossier.data,
      glossaryData: glossary?.status === 'ready' ? glossary.data : null,
    };
  }

  /** Сверху: досье и глоссарий размером в `maxTokens` своих этапов, в символах. */
  private async contextUpperChars(): Promise<number> {
    const [dossier, glossary] = await Promise.all([
      this.llm.getStageSetting(DOSSIER_STAGE),
      this.llm.getStageSetting(GLOSSARY_STAGE),
    ]);
    return (dossier.maxTokens + glossary.maxTokens) * CHARS_PER_TOKEN;
  }

  /**
   * Оценщик перевода моделью для ручки: без цены - 409 `LLM_NO_PRICE` (С6), выключенный этап -
   * 409 `LLM_STAGE_DISABLED`.
   */
  private async estimator(stage: string, model: string): Promise<StageCallEstimator> {
    let call: StageCallEstimator;
    try {
      call = await this.llm.stageCallEstimator(stage, model);
    } catch (error) {
      if (error instanceof LlmError) throw llmTaskConflict(error.code, error.message);
      throw error;
    }
    if (!call.enabled) {
      throw llmTaskConflict('LLM_STAGE_DISABLED', `LLM stage "${stage}" is disabled`);
    }
    return call;
  }

  /** `split` выключен или без цены - не отказ: стыки ставит код (Р7), оценка - ноль. */
  private async splitEstimator(): Promise<StageCallEstimator | null> {
    try {
      const call = await this.llm.stageCallEstimator(SPLIT_STAGE);
      return call.enabled ? call : null;
    } catch (error) {
      if (error instanceof LlmError) return null;
      throw error;
    }
  }
}

function sumMoney(values: Array<Prisma.Decimal | null>): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((sum, v) => (v ? sum.add(v) : sum), new Prisma.Decimal(0));
}

function listItem(row: {
  id: string;
  bookVersionId: string;
  chapterNumber: number;
  language: Language;
  createdAt: Date;
  operation: Parameters<typeof toOperationDto>[0];
  models: Array<{ model: string }>;
}): TranslationCompareListItemDto {
  return {
    id: row.id,
    bookVersionId: row.bookVersionId,
    chapterNumber: row.chapterNumber,
    language: row.language,
    operation: toOperationDto(row.operation),
    models: row.models.map((m) => m.model),
    createdAt: row.createdAt.toISOString(),
  };
}
