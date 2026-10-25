import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Language, LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmTaskService, pairKeyOf } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import { CHECK_SEMANTIC_STAGE } from '../check/check.constants';
import { independentCheckModels } from '../check/check-models';
import {
  EditTranslationChunkDto,
  RetryTranslationChunkDto,
  TranslationChunkDto,
  TranslationChunkEditedDto,
  TranslationChunkRetryStartedDto,
  TranslationChunksDto,
} from '../dto/translation-chunk.dto';
import { assertKnownModels, stageEstimatorFor } from '../llm-model-checks';
import { runStageModels } from '../run/run-models';
import {
  RUN_CHAPTER_CHUNKS_MAX,
  RUN_LANGUAGE_UNFINISHED,
  RUN_TX_OPTIONS,
} from '../run/translation-run.constants';
import { chunksOfChapter } from '../assemble/chapter-input';
import { reportFindings } from '../run/translation-run-report.service';
import { staleClosure } from '../run/stale-closure';
import { verdictOf } from '../check/chunk-verdict';
import { TRANSLATE_STAGE } from '../translate/translate.constants';
import {
  blockText,
  cleanedBlockErrors,
  TranslatedBlock,
  translateBlockErrors,
} from '../translate/translate.format';
import { chunkBlocks } from '../translate/translate-piece';
import {
  CHUNK_BLOCKS_INVALID,
  CHUNK_EDIT_CONFLICT,
  CHUNK_SOURCE_CHANGED,
  DRAFT_MISSING,
  RETRY_IN_PROGRESS,
  RUN_ACTIVE,
} from './chunk-retry.constants';
import {
  cancelRetryOperation,
  chargeRetry,
  lockChunkForWrite,
  newRetry,
  retryJson,
  retryOf,
  retryOpen,
  TRANSLATION_RETRY_KIND,
} from './chunk-retry';
import { retryTaskInput } from './chunk-retry.handler';
import { ChunkRewriteService } from './chunk-rewrite.service';

/** Поля куска наружу - белым списком: ни ответа модели, ни вердикта с сидом, ни `callId`. */
const CHUNK_SELECT = {
  id: true,
  chunkIndex: true,
  firstBlock: true,
  lastBlock: true,
  status: true,
  flagReason: true,
  model: true,
  costUsd: true,
  attempts: true,
  editedAt: true,
  retry: true,
  blocks: true,
  // Только замечания проверяющего наружу (`chunkDto`), без сида и попыток.
  verdict: true,
} as const;

type ChunkRow = Prisma.TranslationChunkGetPayload<{ select: typeof CHUNK_SELECT }>;

/** Кусок с языком и запуском - в объёме проверок повтора и правки. */
const CHUNK_CONTEXT_SELECT = {
  ...CHUNK_SELECT,
  chapterNumber: true,
  chapterFingerprint: true,
  runLanguage: {
    select: {
      id: true,
      language: true,
      status: true,
      bookVersionId: true,
      draftCreatedAt: true,
      run: {
        select: {
          id: true,
          bookVersionId: true,
          operationId: true,
          stageModels: true,
          operation: { select: { settingsSnapshot: true } },
        },
      },
    },
  },
} as const;

type ChunkContext = Prisma.TranslationChunkGetPayload<{ select: typeof CHUNK_CONTEXT_SELECT }>;

/**
 * Куски запуска в админке (`F05-7v`): просмотр «оригинал | перевод» по главам, повтор куска
 * своей операцией и правка руками. Повтор и правка - только когда запуск не идёт и на паре
 * «запуск, язык» нет задачи (`RUN_ACTIVE`, `RETRY_IN_PROGRESS`); язык, закончившийся без
 * черновика, - отказ до трат (`DRAFT_MISSING`). Перезапись главы - `ChunkRewriteService` (Р9).
 */
@Injectable()
export class ChunkRetryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly rewrites: ChunkRewriteService,
  ) {}

  async list(runId: string, language: Language, number: number): Promise<TranslationChunksDto> {
    const lang = await this.prisma.translationRunLanguage.findFirst({
      where: { runId, language },
      select: { id: true, run: { select: { bookVersionId: true } } },
    });
    if (!lang) {
      if (
        !(await this.prisma.translationRun.findUnique({
          where: { id: runId },
          select: { id: true },
        }))
      ) {
        throw new NotFoundException('Translation run not found');
      }
      throw new NotFoundException('The run does not translate to this language');
    }
    const [source, chunks, chapter] = await Promise.all([
      this.sourceOf(lang.run.bookVersionId, number),
      this.prisma.translationChunk.findMany({
        where: { runLanguageId: lang.id, chapterNumber: number },
        orderBy: { chunkIndex: 'asc' },
        select: { ...CHUNK_SELECT, chapterFingerprint: true },
        take: RUN_CHAPTER_CHUNKS_MAX,
      }),
      this.prisma.translationChapter.findUnique({
        where: { runLanguageId_chapterNumber: { runLanguageId: lang.id, chapterNumber: number } },
        select: {
          status: true,
          flagReason: true,
          rewriteRefusal: true,
          chapterId: true,
          findings: true,
        },
      }),
    ]);
    const layout = splitChapter(source?.content ?? '');
    const operations = await this.retryOperations(chunks);
    return {
      runId,
      language,
      chapterNumber: number,
      sourceChanged: chunks.length > 0 && !(source && chunksOfChapter(source.content, chunks)),
      chapter: chapter
        ? {
            status: chapter.status,
            flagReason: chapter.flagReason,
            rewriteRefusal: chapter.rewriteRefusal,
            chapterId: chapter.chapterId,
            findings: reportFindings(chapter.findings),
          }
        : null,
      chunks: chunks.map((c) => chunkDto(c, layout, operations)),
    };
  }

  /**
   * Повтор куска (решения арбитра `F05 | F05-7v`): своя операция `translation_retry` с лимитом,
   * привязкой к запуску и одной задачей на ключе пары запуска. Под замком строки операции
   * запуска: запуск не идёт - иначе 409 `RUN_ACTIVE`; ключ пары занят - `RETRY_IN_PROGRESS`
   * (повтор) или `RUN_ACTIVE` (шаг запуска ещё доделывается). Модели и исходник сверены до
   * транзакции: отказ - до трат и до снятия прежней попытки.
   */
  async retry(
    chunkId: string,
    dto: RetryTranslationChunkDto,
    createdById: string,
  ): Promise<TranslationChunkRetryStartedDto> {
    this.llm.assertEnabled();
    const chunk = await this.context(chunkId);
    const { run } = chunk.runLanguage;
    this.assertDraftPossible(chunk);
    const layout = await this.sourceLayout(chunk);
    if (dto.model) {
      await assertKnownModels(this.llm, [dto.model]);
      await stageEstimatorFor(this.llm, TRANSLATE_STAGE, dto.model);
    }
    const snapshot = run.operation.settingsSnapshot;
    const translate =
      dto.model ??
      runStageModels(snapshot, run.stageModels, TRANSLATE_STAGE).model ??
      (await this.llm.getStageSetting(TRANSLATE_STAGE)).model;
    // Сверка смысла другим семейством, чем модель перевода повтора (`F05-5`): иначе платный
    // повтор кончился бы флагом `NOT_INDEPENDENT`.
    await independentCheckModels(
      this.llm,
      translate,
      runStageModels(snapshot, run.stageModels, CHECK_SEMANTIC_STAGE),
      CHECK_SEMANTIC_STAGE,
    );
    const opData = await this.llm.operationData({
      kind: TRANSLATION_RETRY_KIND,
      bookVersionId: run.bookVersionId,
      limitUsd: new Prisma.Decimal(dto.limitUsd),
      createdById,
      models: dto.model ? [dto.model] : undefined,
    });
    const operationId = await this.prisma.$transaction(async (tx) => {
      const previous = await lockChunkForWrite(tx, chunk.id, run.operationId);
      const op = await tx.llmOperation.create({
        data: { ...opData, translationRunId: run.id },
        select: { id: true },
      });
      const queued = await this.tasks.enqueue(
        retryTaskInput(chunk.id, op.id, run.operationId, chunk.runLanguage.language),
        tx,
      );
      if (!queued.created) throw pairBusy(queued.holder.kind);
      // Прежняя попытка на паузе - отменяется: у куска одна попытка.
      if (retryOpen(previous)) {
        await cancelRetryOperation(tx, previous.operationId);
        await chargeRetry(tx, chunk.id, previous);
      }
      await tx.translationChunk.update({
        where: { id: chunk.id },
        data: { retry: retryJson(newRetry(op.id, dto.model ?? null)) },
      });
      return op.id;
    }, RUN_TX_OPTIONS);
    const fresh = await this.context(chunk.id);
    const operations = await this.retryOperations([fresh]);
    const operation = operations.get(operationId);
    if (!operation) throw new NotFoundException('LLM operation not found');
    return {
      operation: toOperationDto(operation),
      chunk: chunkDto(fresh, layout, operations),
    };
  }

  /**
   * Правка куска руками: блоки - номера куска и тот же белый список строчной разметки, что ответ
   * модели (`F05-3`, шаг 2); пустой после очистки блок - 400. Кусок сохраняется всегда, глава -
   * по Р9; отказ перезаписи - 200 с `chapterRewritten: false` и причиной (решение арбитра).
   */
  async edit(chunkId: string, dto: EditTranslationChunkDto): Promise<TranslationChunkEditedDto> {
    const chunk = await this.context(chunkId);
    this.assertDraftPossible(chunk);
    const layout = await this.sourceLayout(chunk);
    const blocks = editedBlocks(layout, chunk, dto.blocks);
    const { run, language } = chunk.runLanguage;
    const result = await this.rewrites.apply(chunk.id, {
      kind: 'manual',
      blocks,
      lock: async (tx) => {
        const retry = await lockChunkForWrite(tx, chunk.id, run.operationId);
        const holder = await tx.llmTask.findFirst({
          where: {
            pairKey: pairKeyOf(run.operationId, language),
            status: { in: ['pending', 'running'] },
          },
          select: { kind: true },
        });
        if (holder) throw pairBusy(holder.kind);
        return retry;
      },
    });
    // Не применена: строку главы или куска сменили встречно под замком - правка не сохранена.
    if (!result.applied) {
      throw llmTaskConflict(CHUNK_EDIT_CONFLICT, 'The piece changed concurrently, try again');
    }
    const fresh = await this.context(chunk.id);
    return {
      chunk: chunkDto(fresh, layout, await this.retryOperations([fresh])),
      chapterRewritten: result.chapterRewritten,
      reason: result.reason,
    };
  }

  private async context(chunkId: string): Promise<ChunkContext> {
    const chunk = await this.prisma.translationChunk.findUnique({
      where: { id: chunkId },
      select: CHUNK_CONTEXT_SELECT,
    });
    if (!chunk) throw new NotFoundException('Translation chunk not found');
    return chunk;
  }

  private sourceOf(bookVersionId: string, number: number) {
    return this.prisma.chapter.findUnique({
      where: { bookVersionId_number: { bookVersionId, number } },
      select: { content: true },
    });
  }

  /**
   * Раскладка главы исходника, с которой нарезан кусок (`chunksOfChapter` - одно правило со
   * сборкой); главу правили после нарезки - 409 `CHUNK_SOURCE_CHANGED` до трат и записи.
   */
  private async sourceLayout(chunk: ChunkContext): Promise<ChapterLayout> {
    const source = await this.sourceOf(chunk.runLanguage.run.bookVersionId, chunk.chapterNumber);
    if (!source || !chunksOfChapter(source.content, [chunk])) {
      throw llmTaskConflict(
        CHUNK_SOURCE_CHANGED,
        'The source chapter changed after the split: the piece is not the same',
      );
    }
    return splitChapter(source.content);
  }

  /** Операции попыток повтора кусков одним запросом: статус, пауза, траты и лимит наружу. */
  private async retryOperations(
    chunks: ReadonlyArray<{ retry: Prisma.JsonValue }>,
  ): Promise<Map<string, LlmOperation>> {
    const ids = chunks.flatMap((c) => {
      const retry = retryOf(c.retry);
      return retry ? [retry.operationId] : [];
    });
    if (ids.length === 0) return new Map();
    const ops = await this.prisma.llmOperation.findMany({ where: { id: { in: ids } } });
    return new Map(ops.map((op) => [op.id, op]));
  }

  /**
   * Язык закончен, а черновика нет (`NO_CHAPTERS_WRITTEN`, отказ создания), или черновик удалён
   * (ссылка снята, `draftCreatedAt` осталась - язык закроет `DRAFT_DELETED`): писать некуда.
   */
  private assertDraftPossible(chunk: ChunkContext): void {
    const lang = chunk.runLanguage;
    const unfinished = (RUN_LANGUAGE_UNFINISHED as readonly string[]).includes(lang.status);
    // «Черновик удалён» - одним правилом с запуском (`staleClosure`).
    const deleted = staleClosure([lang]).deleted.length > 0;
    if ((!unfinished && lang.bookVersionId === null) || deleted) {
      throw llmTaskConflict(
        DRAFT_MISSING,
        'The language has no draft version: there is nowhere to write the chapter',
      );
    }
  }
}

/** Ключ пары занят: повтором - ждать его, шагом запуска - он ещё доделывается после паузы. */
function pairBusy(kind: string) {
  return kind === TRANSLATION_RETRY_KIND
    ? llmTaskConflict(RETRY_IN_PROGRESS, 'A piece retry of this language is in progress')
    : llmTaskConflict(RUN_ACTIVE, 'A step of the translation run is still in progress');
}

/**
 * Блоки правки: каждый переводимый блок куска ровно один раз, чужих нет, после белого списка
 * разметки не пусто - иначе 400 со списком ошибок. Текст - тем же `blockText`, что ответ модели.
 */
function editedBlocks(
  layout: ChapterLayout,
  chunk: { firstBlock: number; lastBlock: number },
  blocks: ReadonlyArray<{ n: number; text: string }>,
): TranslatedBlock[] {
  const source = chunkBlocks(layout, chunk);
  const kinds = new Map(layout.blocks.map((b) => [b.n, b]));
  const value = { blocks: blocks.map((b) => ({ n: b.n, text: b.text })) };
  const numbers = translateBlockErrors(
    value,
    source.map((b) => b.n),
  );
  const errors = numbers.length > 0 ? numbers : cleanedBlockErrors(value, kinds);
  if (errors.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: errors,
      code: CHUNK_BLOCKS_INVALID,
    });
  }
  return value.blocks.map((b) => ({
    n: b.n,
    text: blockText(kinds.get(b.n) ?? { kind: 'p', html: '' }, b.text),
  }));
}

function chunkDto(
  c: ChunkRow,
  layout: ChapterLayout,
  operations: ReadonlyMap<string, LlmOperation>,
): TranslationChunkDto {
  const translated = new Map(
    (Array.isArray(c.blocks) ? (c.blocks as unknown as TranslatedBlock[]) : []).map((b) => [
      b.n,
      b.text,
    ]),
  );
  const retry = retryOf(c.retry);
  const op = retry ? operations.get(retry.operationId) : undefined;
  return {
    id: c.id,
    chunkIndex: c.chunkIndex,
    firstBlock: c.firstBlock,
    lastBlock: c.lastBlock,
    status: c.status,
    flagReason: c.flagReason,
    model: c.model,
    costUsd: c.costUsd ? moneyUsd(c.costUsd) : null,
    attempts: c.attempts,
    remarks: verdictOf(c.verdict)?.remarks ?? [],
    editedAt: c.editedAt ? c.editedAt.toISOString() : null,
    retry: retry
      ? {
          operationId: retry.operationId,
          status: retry.status,
          requestedModel: retry.requestedModel,
          model: retry.model ?? null,
          reason: retry.reason ?? null,
          reasonModels: retry.reasonModels ?? [],
          costUsd: moneyUsd(new Prisma.Decimal(retry.costUsd)),
          operationStatus: op?.status ?? null,
          pauseReason: op?.pauseReason ?? null,
          spentUsd: op ? moneyUsd(op.spentUsd) : null,
          limitUsd: op ? moneyUsd(op.limitUsd) : null,
        }
      : null,
    blocks: chunkBlocks(layout, c).map((b) => ({
      n: b.n,
      source: b.html,
      translation: translated.get(b.n) ?? null,
    })),
  };
}
