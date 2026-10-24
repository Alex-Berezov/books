import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Language, LlmOperation, Prisma, TranslationRunLanguage } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginatedResult, paginated } from '../../../shared/dto/paginated-response.dto';
import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import {
  BOOK_LANGUAGE_TX_OPTIONS,
  lockBookLanguages,
  unfinishedRunLanguages,
} from '../../book-version/book-language-lock';
import { approvedTargetLanguages } from '../../book-version/intake-target-languages';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmOperationsService } from '../../llm-worker/llm-operations.service';
import { EnqueueTaskInput, LlmTaskService, pairKeyOf } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { DOSSIER_MAX_CHAPTERS } from '../dossier/dossier.constants';
import { DossierService } from '../dossier/dossier.service';
import { assertKnownModels, stageEstimatorFor } from '../llm-model-checks';
import { TranslationTargetReason } from '../translation-source';
import { TranslationSourceService } from '../translation-source.service';
import { chapterCheckUsd, chapterSeamUsd, checkEstimator } from '../check/check-estimate';
import { CHECK_NO_COMPLIANT_PROVIDER, CHECK_SEMANTIC_STAGE } from '../check/check.constants';
import { independentCheckModels } from '../check/check-models';
import { FINAL_CHECK_STAGE } from '../final-check/final-check.constants';
import { chapterFinalCheckUsd, finalCheckEstimator } from '../final-check/final-check-estimate';
import { METADATA_STAGE } from '../metadata/metadata.constants';
import { metadataSourceFields, metadataUsd } from '../metadata/metadata-step';
import { TRANSLATE_STAGE } from '../translate/translate.constants';
import {
  chapterSplitUsd,
  chapterTranslateUsd,
  contextUpperChars,
  hasTranslatableText,
  planChapter,
  readyContext,
  splitEstimator,
} from '../translate/translate-estimate';
import { runStageModels } from './run-models';
import { CHUNK_CLOSED_STATUSES, TRANSLATION_RUN_TASK_KIND } from './translation-run.constants';
import {
  ResumeTranslationRunDto,
  StartTranslationRunDto,
  TranslationRunEstimateQueryDto,
  TranslationRunStageModelsDto,
} from '../dto/translation-run-request.dto';
import { CompareContextLineDto } from '../dto/translation-compare-response.dto';
import {
  TranslationRunDto,
  TranslationRunEstimateDto,
  TranslationRunLanguageDto,
  TranslationRunLanguageEstimateDto,
  TranslationRunListItemDto,
  TranslationRunStage,
} from '../dto/translation-run-response.dto';

/** Глава исходника с этой доли предела длины главы - предупреждение в оценке (Р8). */
const NEAR_LIMIT_SHARE = 0.8;

/**
 * Задача языка запуска: ключ пары «операция:язык» (Р1). Без `bookVersionId`: задача от версии
 * каскадом не удаляется, и удаление исходника посреди запуска доходит до шага - тот закрывает
 * операцию `failed`, а не оставляет её `active` без задач.
 */
export function runTaskInput(
  runLanguageId: string,
  language: Language,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: TRANSLATION_RUN_TASK_KIND,
    operationId,
    language,
    payload: { runLanguageId },
    pairKey: pairKeyOf(operationId, language),
  };
}

interface Estimate {
  dto: TranslationRunEstimateDto;
  sourceLanguage: Language;
  /** Сумма лимитов досье и глоссариев, которые строятся первыми: лимит запуска не меньше. */
  minLimitUsd: Prisma.Decimal;
}

interface BlockedLanguage {
  language: Language;
  reason: TranslationTargetReason;
}

/**
 * Запуск перевода (`F05-4`): оценка и старт (`F05-4b`, шаги 2-3), ход и кнопки «пауза»,
 * «продолжить», «отменить» (шаги 6-7), запуски книги. Старт - под замком языка книги, общим
 * с ручным созданием версии (Р6): язык с версией или с незавершённым запуском (Р23) не стартует.
 * Переходы - общими методами операций: отмена закрывает языки (`onCancelled`), «продолжить»
 * ставит задачу на каждый недоделанный язык (`resumeTasks`).
 */
@Injectable()
export class TranslationRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly operations: LlmOperationsService,
    private readonly budget: LlmBudgetService,
    private readonly sources: TranslationSourceService,
    private readonly dossiers: DossierService,
  ) {}

  async estimate(
    versionId: string,
    query: TranslationRunEstimateQueryDto,
  ): Promise<TranslationRunEstimateDto> {
    return (await this.estimateOf(versionId, query)).dto;
  }

  /**
   * Старт: оценка, пол лимита и снимок настроек - до транзакции (`L-020`); под замком языков -
   * только их доступность и запись. Потолок на старте не проверяется: запуск встаёт на паузу
   * `CEILING_REACHED` первым шагом. Языки отказывают все вместе: лимит задан на весь набор
   * (решения арбитра `F05 | F05-4b`).
   */
  async start(
    versionId: string,
    dto: StartTranslationRunDto,
    createdById: string,
  ): Promise<TranslationRunDto> {
    this.llm.assertEnabled();
    const estimate = await this.estimateOf(versionId, dto);
    const opData = await this.llm.operationData({
      kind: 'translation_run',
      bookVersionId: versionId,
      limitUsd: dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      createdById,
      models: dto.translateModel ? [dto.translateModel] : undefined,
    });
    // Досье и глоссарии ждут в остатке лимита запуска (С12): меньший лимит заводил бы
    // операцию, которая встаёт на паузу `LIMIT_REACHED` первым же шагом, ничего не сделав.
    if (new Prisma.Decimal(opData.limitUsd as Prisma.Decimal.Value).lt(estimate.minLimitUsd)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `limitUsd must fit the dossier and glossaries built first: at least ${moneyUsd(estimate.minLimitUsd)}`,
        code: 'TRANSLATION_RUN_LIMIT_TOO_LOW',
      });
    }
    // Версию могли удалить после оценки: 404, а не 500. Книга версии не меняется - читается до
    // транзакции, и замок остаётся её первым оператором; удаление после этого чтения ловит FK ниже.
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { bookId: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    const { bookId } = version;
    const id = await this.prisma
      .$transaction(async (tx) => {
        // Под замком языки перечитываются: встречный старт или ручная версия могли успеть.
        await lockBookLanguages(tx, bookId, dto.languages);
        await this.assertLanguagesFree(tx, bookId, dto.languages);
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const run = await tx.translationRun.create({
          data: {
            operationId: op.id,
            bookVersionId: versionId,
            sourceLanguage: estimate.sourceLanguage,
            stageModels: dto.translateModel ? { [TRANSLATE_STAGE]: dto.translateModel } : {},
            languages: { create: [...dto.languages].sort().map((language) => ({ language })) },
          },
          include: { languages: true },
        });
        await tx.llmOperation.update({ where: { id: op.id }, data: { translationRunId: run.id } });
        for (const l of run.languages) {
          await this.tasks.enqueue(runTaskInput(l.id, l.language, op.id), tx);
        }
        return run.id;
      }, BOOK_LANGUAGE_TX_OPTIONS)
      .catch(async (e: unknown) => {
        // Версию удалили между чтением и записью запуска (FK P2003) - 404; иной FK (автор
        // запуска удалён) - как есть, а не «версия не найдена».
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2003' &&
          !(await this.prisma.bookVersion.findUnique({
            where: { id: versionId },
            select: { id: true },
          }))
        ) {
          throw new NotFoundException('Book version not found');
        }
        throw e;
      });
    return this.get(id);
  }

  /** Запуски книги, новые первыми: один список и для блока хода, и для истории (`F05-8`). */
  async listForBook(
    bookId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<TranslationRunListItemDto>> {
    // Пустой список и «нет такой книги» - разные ответы, как у ручек версии.
    if (!(await this.prisma.book.findUnique({ where: { id: bookId }, select: { id: true } }))) {
      throw new NotFoundException('Book not found');
    }
    const where = { bookVersion: { bookId } };
    const [rows, total] = await Promise.all([
      this.prisma.translationRun.findMany({
        where,
        include: {
          operation: true,
          languages: { select: { language: true }, orderBy: { language: 'asc' } },
        },
        // `id` - второй ключ: запуски одной миллисекунды не меняются местами между страницами.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.translationRun.count({ where }),
    ]);
    return paginated(
      rows.map((run) => ({
        id: run.id,
        bookVersionId: run.bookVersionId,
        sourceLanguage: run.sourceLanguage,
        languages: run.languages.map((l) => l.language),
        stageModels: (run.stageModels ?? {}) as TranslationRunStageModelsDto,
        operation: toOperationDto(run.operation),
        createdAt: run.createdAt.toISOString(),
      })),
      { page, limit, total },
    );
  }

  async get(id: string): Promise<TranslationRunDto> {
    const run = await this.prisma.translationRun.findUnique({
      where: { id },
      include: { operation: true, languages: { orderBy: { language: 'asc' } } },
    });
    if (!run) throw new NotFoundException('Translation run not found');
    const [chapters, chunks] = await Promise.all([
      // Номера глав исходника - для «глава N из M»; глав не больше предела досье.
      this.prisma.chapter.findMany({
        where: { bookVersionId: run.bookVersionId },
        select: { number: true },
        orderBy: { number: 'asc' },
        take: DOSSIER_MAX_CHAPTERS,
      }),
      // Строк не больше, чем языков × статусов куска: группировка, а не выборка кусков.
      this.prisma.translationChunk.groupBy({
        by: ['runLanguageId', 'chapterNumber', 'status'],
        where: {
          OR: run.languages
            .filter((l) => l.chapterNumber !== null)
            .map((l) => ({ runLanguageId: l.id, chapterNumber: l.chapterNumber as number })),
        },
        _count: { _all: true },
      }),
    ]);
    const numbers = chapters.map((c) => c.number);
    return {
      id: run.id,
      bookVersionId: run.bookVersionId,
      sourceLanguage: run.sourceLanguage,
      dossierId: run.dossierId,
      stageModels: (run.stageModels ?? {}) as TranslationRunStageModelsDto,
      operation: toOperationDto(run.operation),
      createdAt: run.createdAt.toISOString(),
      languages: run.languages.map((l) =>
        languageDto(
          l,
          run.dossierId !== null,
          numbers,
          chunks.filter((c) => c.runLanguageId === l.id && c.chapterNumber === l.chapterNumber),
        ),
      ),
    };
  }

  /** Пауза кнопкой: причины нет (`pauseReason: null`), шаг, который идёт, доделывается (Р19). */
  async pause(id: string): Promise<TranslationRunDto> {
    const op = await this.operationOf(id);
    if (!(await this.tasks.pauseOperation(op.id, null))) {
      throw llmTaskConflict('TRANSLATION_RUN_NOT_PAUSABLE', 'Translation run is not running');
    }
    return this.get(id);
  }

  /**
   * «Продолжить» с новым лимитом и моделями этапов. Модели пишутся транзакцией «продолжить»,
   * после перевода операции в `active` и до постановки задач: отказ (лимит, повтор куска)
   * откатывает и их, шаг, взятый сразу после, уже на них. Строка операции к этому моменту
   * под замком - второе «продолжить» читает модели после первого.
   */
  async resume(id: string, dto: ResumeTranslationRunDto): Promise<TranslationRunDto> {
    const op = await this.operationOf(id);
    // Отказ «продолжить» - раньше проверки моделей: не на паузе или в тупике - код отказа
    // операции, а не модели, и без лишнего запроса каталога.
    if (op.status !== 'paused' || op.pauseReason === 'DOSSIER_STALE') {
      throw llmTaskConflict('LLM_OPERATION_NOT_RESUMABLE', 'LLM operation cannot be resumed');
    }
    // Только заданные этапы: `{ translate: undefined }` модели не стирает.
    const changed = Object.fromEntries(
      Object.entries(dto.stageModels ?? {}).filter(([, model]) => model !== undefined),
    ) as Record<string, string>;
    let checked: Record<string, string> | null = null;
    if (Object.keys(changed).length > 0) {
      await this.assertStageModels(changed);
      checked = await this.assertCheckFamily(id, changed);
    }
    await this.operations.resume(
      op.id,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      Object.keys(changed).length > 0
        ? async (tx) => {
            const run = await tx.translationRun.findUniqueOrThrow({
              where: { id },
              select: { stageModels: true },
            });
            // Модели сверены до транзакции (каталог - сетевой вызов, не под замком). Параллельное
            // «продолжить» успело их сменить - пара не сверена: отказ, а не запись мимо проверки.
            if (!sameModels(run.stageModels, checked)) {
              throw llmTaskConflict(
                'TRANSLATION_RUN_MODELS_CHANGED',
                'Stage models of the run changed concurrently, retry',
              );
            }
            await tx.translationRun.update({
              where: { id },
              data: { stageModels: { ...(run.stageModels as Record<string, string>), ...changed } },
            });
          }
        : undefined,
    );
    return this.get(id);
  }

  async cancel(id: string): Promise<TranslationRunDto> {
    const op = await this.operationOf(id);
    await this.operations.cancel(op.id);
    return this.get(id);
  }

  private async operationOf(id: string): Promise<LlmOperation> {
    const run = await this.prisma.translationRun.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!run) throw new NotFoundException('Translation run not found');
    return run.operation;
  }

  /**
   * Оценка сверху по всей книге (`F05-4b`, шаг 2): куски каждой главы по границам кода, на язык -
   * `split` по спорным стыкам, `translate` и `check_semantic` по кускам (сверка смысла - решение
   * арбитра `F05 | F05-5`) и стыкам глав (`F05-6`, 6c), `final_check` - вызов на главу, `metadata` -
   * вызов на язык (`F05-6`); досье одно на книгу, глоссарий на язык -
   * строками, если их строить (устаревшее досье тоже: запуск строит его заново). Выход вызова -
   * `maxTokens` этапа, без коэффициента длины языка (решения арбитра `F05 | F05-4b`).
   */
  private async estimateOf(
    versionId: string,
    query: TranslationRunEstimateQueryDto,
  ): Promise<Estimate> {
    const sourceLanguage = await this.assertSource(versionId, query.languages);
    if (query.translateModel) await assertKnownModels(this.llm, [query.translateModel]);
    const call = await stageEstimatorFor(this.llm, TRANSLATE_STAGE, query.translateModel);
    const chapters = await this.prisma.chapter.findMany({
      where: { bookVersionId: versionId, content: { not: '' } },
      select: { number: true, content: true },
      orderBy: { number: 'asc' },
      take: DOSSIER_MAX_CHAPTERS + 1,
    });
    if (chapters.length > DOSSIER_MAX_CHAPTERS) {
      throw llmTaskConflict(
        'SOURCE_TOO_MANY_CHAPTERS',
        `The source has more than ${DOSSIER_MAX_CHAPTERS} chapters`,
      );
    }
    const nearLimit = RICH_HTML_MAX_LENGTH.body * NEAR_LIMIT_SHARE;
    const nearLimitChapters = chapters
      .filter((c) => sanitizeRichHtml(c.content).length >= nearLimit)
      .map((c) => c.number);
    const plans = (await Promise.all(chapters.map((c) => planChapter(c.number, c.content)))).filter(
      hasTranslatableText,
    );
    // Главы есть, но переводить в них нечего (`hr`, картинки без подписей): запуск построил бы
    // досье и глоссарии за деньги и ничего не перевёл.
    if (plans.length === 0) {
      throw llmTaskConflict('TRANSLATION_SOURCE_EMPTY', 'The source has no text to translate');
    }

    const fields = await metadataSourceFields(this.prisma, versionId, sourceLanguage);
    if (!fields) throw new NotFoundException('Book version not found');
    const context = await this.dossiers.contextEstimates(versionId, query.languages, {
      rebuildStale: true,
    });
    const split = await splitEstimator(this.llm);
    const translateModel =
      query.translateModel ?? (await this.llm.getStageSetting(TRANSLATE_STAGE)).model;
    const [check, finalCheck] = await Promise.all([
      checkEstimator(this.llm, translateModel),
      finalCheckEstimator(this.llm, translateModel),
    ]);
    const metadata = await stageEstimatorFor(this.llm, METADATA_STAGE);
    // Нарезка - на каждый язык своя (выборы стыков хранит язык запуска).
    const splitUsd = plans.reduce((sum, p) => sum.add(chapterSplitUsd(split, p)), zero());
    let upperBound = false;
    let translationsUsd = zero();
    let minLimitUsd = context.dossier?.suggestedLimitUsd ?? zero();
    let contextUsd = context.dossier?.estimateUsd ?? zero();
    // Вход сверх промпта, пока контекст не готов: от языка не зависит - один раз на оценку.
    let upperChars: number | undefined;
    const languages: TranslationRunLanguageEstimateDto[] = [];
    for (const language of query.languages) {
      const glossary = context.glossaries.get(language) ?? null;
      // Строится досье или глоссарий - вход сверху по размеру их ответа, а не по старым данным.
      const ready =
        context.dossier === null && glossary === null
          ? await readyContext(this.prisma, this.dossiers, context.sourceVersionId, language)
          : { dossierData: null, glossaryData: null };
      const upper = ready.dossierData === null || ready.glossaryData === null;
      upperBound ||= upper;
      if (upper) upperChars ??= await contextUpperChars(this.llm);
      const extra = upper ? (upperChars as number) : 0;
      const translateUsd = plans.reduce(
        (sum, plan) =>
          sum.add(
            chapterTranslateUsd(call, plan, {
              dossier: ready.dossierData,
              glossary: ready.glossaryData,
              sourceLanguage,
              targetLanguage: language,
              extra,
            }),
          ),
        zero(),
      );
      const pair = { sourceLanguage, targetLanguage: language };
      const checkUsd = plans.reduce(
        (sum, plan) =>
          sum
            .add(
              chapterCheckUsd(check, plan, {
                ...pair,
                translateMaxTokens: call.maxTokens,
              }),
            )
            .add(chapterSeamUsd(check, plan, pair)),
        zero(),
      );
      const finalCheckUsd = plans.reduce(
        (sum, plan) =>
          sum.add(
            chapterFinalCheckUsd(finalCheck, plan, pair, {
              glossary: ready.glossaryData,
              dossier: ready.dossierData,
              extra,
            }),
          ),
        zero(),
      );
      const languageMetadataUsd = metadataUsd(
        metadata,
        { ...fields, targetLanguage: language },
        { glossary: ready.glossaryData, dossier: ready.dossierData, extra },
      );
      const totalUsd = splitUsd
        .add(translateUsd)
        .add(checkUsd)
        .add(finalCheckUsd)
        .add(languageMetadataUsd);
      translationsUsd = translationsUsd.add(totalUsd);
      if (glossary) {
        minLimitUsd = minLimitUsd.add(glossary.suggestedLimitUsd);
        contextUsd = contextUsd.add(glossary.estimateUsd);
      }
      languages.push({
        language,
        glossary: glossary && contextLine(glossary),
        splitUsd: moneyUsd(splitUsd),
        translateUsd: moneyUsd(translateUsd),
        checkUsd: moneyUsd(checkUsd),
        finalCheckUsd: moneyUsd(finalCheckUsd),
        metadataUsd: moneyUsd(languageMetadataUsd),
        totalUsd: moneyUsd(totalUsd),
      });
    }
    const budget = await this.budget.getBudget();
    return {
      sourceLanguage,
      minLimitUsd,
      dto: {
        translateModel,
        chapters: plans.length,
        chunks: plans.reduce((sum, p) => sum + p.chunks.length, 0),
        dossier: context.dossier && contextLine({ ...context.dossier, upperBound: false }),
        languages,
        upperBound,
        translationsUsd: moneyUsd(translationsUsd),
        totalUsd: moneyUsd(translationsUsd.add(contextUsd)),
        minLimitUsd: moneyUsd(minLimitUsd),
        defaultLimitUsd: moneyUsd(budget?.defaultRunLimitUsd ?? zero()),
        nearLimitChapters,
      },
    };
  }

  /**
   * Версия - исходник по D8, языки - доступны по `translation-source` с причиной «на язык идёт
   * перевод». Возвращает язык исходника. Под замком старта языки проверяются ещё раз.
   */
  private async assertSource(versionId: string, languages: readonly Language[]): Promise<Language> {
    const { source } = await this.sources.forVersion(versionId, { withRunsInProgress: true });
    // Все языки закрыты своими причинами - отказ по языкам ниже, а не общий.
    if (source.reason && source.reason !== 'NO_AVAILABLE_TARGETS') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'This version cannot be a translation source',
        code: source.reason,
        sourceVersionId: source.sourceVersionId,
      });
    }
    const blocked = languages.flatMap((language): BlockedLanguage[] => {
      const reason = source.targets.find((t) => t.language === language)?.reason;
      return reason ? [{ language, reason }] : [];
    });
    if (blocked.length > 0) throw targetsUnavailable(blocked);
    return source.sourceLanguage as Language;
  }

  /**
   * Языки под замком (`F05-4b`, шаг 3): версия появилась, идёт перевод (Р23) или язык убрали
   * из анкеты - тем же отказом и в том же порядке причин, что и до замка (`translation-source`).
   * Язык исходника под замком не перечитывается: его меняет не создание версии и не старт.
   */
  private async assertLanguagesFree(
    tx: Prisma.TransactionClient,
    bookId: string,
    languages: readonly Language[],
  ): Promise<void> {
    const [versions, inProgress, book] = await Promise.all([
      tx.bookVersion.findMany({
        where: { bookId, language: { in: [...languages] } },
        select: { language: true },
      }),
      unfinishedRunLanguages(tx, bookId, languages),
      tx.book.findUnique({
        where: { id: bookId },
        select: { rightsIntake: { select: { targetLanguages: true } } },
      }),
    ]);
    const taken = new Set(versions.map((v) => v.language));
    const intake = approvedTargetLanguages(book?.rightsIntake?.targetLanguages);
    const blocked = languages.flatMap((language): BlockedLanguage[] => {
      if (taken.has(language)) return [{ language, reason: 'VERSION_EXISTS' }];
      if (inProgress.includes(language)) return [{ language, reason: 'TRANSLATION_IN_PROGRESS' }];
      if (!intake?.includes(language)) return [{ language, reason: 'NOT_IN_INTAKE' }];
      return [];
    });
    if (blocked.length > 0) throw targetsUnavailable(blocked);
  }

  /**
   * Модель этапа - из каталога OpenRouter, с ценой и на включённом этапе: иначе первый же шаг
   * встал бы на ту же паузу. Правило семейств перевода и проверки - `F05-5`.
   */
  private async assertStageModels(stageModels: Record<string, string>): Promise<void> {
    // Какие этапы можно сменить и что значение - строка, держит `TranslationRunStageModelsDto`.
    await assertKnownModels(this.llm, Object.values(stageModels));
    for (const [stage, model] of Object.entries(stageModels)) {
      await stageEstimatorFor(this.llm, stage, model);
    }
  }

  /**
   * Модели после «продолжить» - сверка смысла и итоговая проверка другого семейства, чем модель перевода запуска
   * (`independentCheckModels` - одно правило с оценкой и стартом): при смене любой из двух моделей.
   * Возвращает модели запуска, по которым сверено: транзакция «продолжить» сравнивает их под замком.
   */
  private async assertCheckFamily(
    id: string,
    changed: Record<string, string>,
  ): Promise<Record<string, string>> {
    const run = await this.prisma.translationRun.findUniqueOrThrow({
      where: { id },
      select: { stageModels: true, operation: { select: { settingsSnapshot: true } } },
    });
    const stageModels = { ...(run.stageModels as Record<string, string>), ...changed };
    const snapshot = run.operation.settingsSnapshot;
    const translate =
      runStageModels(snapshot, stageModels, TRANSLATE_STAGE).model ??
      (await this.llm.getStageSetting(TRANSLATE_STAGE)).model;
    for (const stage of [CHECK_SEMANTIC_STAGE, FINAL_CHECK_STAGE]) {
      await independentCheckModels(
        this.llm,
        translate,
        runStageModels(snapshot, stageModels, stage),
        stage,
      );
    }
    return (run.stageModels ?? {}) as Record<string, string>;
  }
}

/** Модели запуска не менялись с прочтения до транзакции (`null` - моделей не меняли, сверять нечего). */
function sameModels(fresh: Prisma.JsonValue, read: Record<string, string> | null): boolean {
  if (read === null) return true;
  const now = (fresh ?? {}) as Record<string, string>;
  return [TRANSLATE_STAGE, CHECK_SEMANTIC_STAGE, METADATA_STAGE, FINAL_CHECK_STAGE].every(
    (stage) => now[stage] === read[stage],
  );
}

function zero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

function contextLine(line: {
  estimateUsd: Prisma.Decimal;
  suggestedLimitUsd: Prisma.Decimal;
  upperBound: boolean;
}): CompareContextLineDto {
  return {
    estimateUsd: moneyUsd(line.estimateUsd),
    suggestedLimitUsd: moneyUsd(line.suggestedLimitUsd),
    upperBound: line.upperBound,
  };
}

/** Старт невозможен на эти языки: один отказ, причина на каждый (решение арбитра `F05 | F05-4b`). */
function targetsUnavailable(languages: BlockedLanguage[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: `Translation is not available for: ${languages.map((l) => l.language).join(', ')}`,
    code: 'TRANSLATION_TARGET_UNAVAILABLE',
    languages,
  });
}

function languageDto(
  l: TranslationRunLanguage,
  hasDossier: boolean,
  chapters: readonly number[],
  chunks: Array<{ status: string; _count: { _all: number } }>,
): TranslationRunLanguageDto {
  const total = chunks.reduce((sum, c) => sum + c._count._all, 0);
  const done = chunks
    .filter((c) => (CHUNK_CLOSED_STATUSES as readonly string[]).includes(c.status))
    .reduce((sum, c) => sum + c._count._all, 0);
  const position = l.chapterNumber === null ? -1 : chapters.indexOf(l.chapterNumber);
  return {
    language: l.language,
    status: l.status,
    stage: stageOf(l, hasDossier, chunks, position >= 0 && position === chapters.length - 1),
    reason: l.reason,
    reasonText: l.reasonText,
    // Колонка в базе допускает NULL (строки до записи причины): наружу - пустой список.
    reasonModels: l.reasonModels ?? [],
    chapterNumber: l.chapterNumber,
    chapterPosition: position >= 0 ? position + 1 : null,
    chaptersTotal: chapters.length,
    chunksDone: done,
    chunksTotal: total,
    flaggedChunks: l.flaggedChunks,
    glossaryId: l.glossaryId,
    blockedByOperationId: l.blockedByOperationId,
  };
}

/** Куски, которые сейчас проверяются: переведён и ждёт проверок или проверен и ждёт находок. */
const CHECKING: readonly string[] = ['translated', 'checked'];

/**
 * Этап языка словами `product.md` §2.3: досье, глоссарий, перевод (с нарезкой главы), проверка
 * (кусок текущей главы между переводом и находками или пауза сверки смысла без провайдера,
 * решение арбитра `F05 | F05-5`); у закончившего - его статус (решение арбитра `F05 | F05-4a`,
 * В6); сборка - последняя глава закрыта целиком: главы собираются и идёт этап `metadata` (`F05-6`).
 * Куски - группировка текущей главы языка (запрос на весь ход, `get`).
 */
function stageOf(
  l: TranslationRunLanguage,
  hasDossier: boolean,
  chunks: ReadonlyArray<{ status: string }>,
  lastChapter: boolean,
): TranslationRunStage {
  if (l.status === 'done' || l.status === 'failed' || l.status === 'cancelled') return l.status;
  if (!hasDossier) return 'dossier';
  if (!l.glossaryId) return 'glossary';
  const closed = chunks.every((c) =>
    (CHUNK_CLOSED_STATUSES as readonly string[]).includes(c.status),
  );
  if (lastChapter && chunks.length > 0 && closed) return 'assemble';
  const checking =
    l.reason === CHECK_NO_COMPLIANT_PROVIDER || chunks.some((c) => CHECKING.includes(c.status));
  return checking ? 'check' : 'translate';
}
