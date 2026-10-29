import { Injectable } from '@nestjs/common';
import { LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService, pairKeyOf } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { splitChapter } from '../chapter-blocks';
import { DRAFT_FLAG_REASONS } from '../draft/draft.constants';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import { runStageModels } from '../run/run-models';
import { RUN_CHAPTER_CHUNKS_MAX } from '../run/translation-run.constants';
import { chunksOfChapter } from '../assemble/chapter-input';
import {
  checkChunk,
  CHUNK_STEP_SELECT,
  chunkStepContext,
  ChunkStepInput,
  translateChunk,
} from '../translate/chunk-steps';
import { TRANSLATE_STAGE } from '../translate/translate.constants';
import { noProviderReason } from '../run/run-step-support.service';
import { RETRY_CANCELLED, RETRY_NOT_APPLIED } from './chunk-retry.constants';
import {
  assertRunStopped,
  ChunkRetry,
  markRetryFailed,
  retryOf,
  setRetryReason,
  retryOpen,
  retryStepChunk,
  retryStore,
  TRANSLATION_RETRY_KIND,
} from './chunk-retry';
import { ChunkRewriteService } from './chunk-rewrite.service';

/** Кусок повтора с языком и запуском - в объёме шага. */
const RETRY_CHUNK_SELECT = {
  ...CHUNK_STEP_SELECT,
  chapterNumber: true,
  chapterFingerprint: true,
  retry: true,
  runLanguage: {
    select: {
      id: true,
      language: true,
      glossaryId: true,
      run: {
        select: {
          bookVersionId: true,
          sourceLanguage: true,
          dossierId: true,
          stageModels: true,
          operation: { select: { settingsSnapshot: true } },
        },
      },
    },
  },
} as const;

type RetryChunk = Prisma.TranslationChunkGetPayload<{ select: typeof RETRY_CHUNK_SELECT }>;

/**
 * Задача повтора куска: ключ пары - от операции **запуска** (Р1, `pairKeyOf`), операция - своя.
 * Пока задача держит пару, «продолжить» запуска отвечает 409 `RETRY_IN_PROGRESS`, а шаг запуска
 * на этот язык не встанет.
 */
export function retryTaskInput(
  chunkId: string,
  operationId: string,
  runOperationId: string,
  language: Parameters<typeof pairKeyOf>[1],
): EnqueueTaskInput {
  return {
    kind: TRANSLATION_RETRY_KIND,
    operationId,
    language,
    chunkId,
    payload: { chunkId },
    pairKey: pairKeyOf(runOperationId, language),
  };
}

/**
 * Шаги повтора куска (`F05-7v`; решения арбитра `F05 | F05-7v`): те же перевод и проверки, что
 * у запуска (`translate/chunk-steps.ts`), за счёт своей операции и в попытку `retry`, шаг за
 * раз: перевод → проверки (провал - перевод заново с замечаниями, вторая неудача - флаг) →
 * подмена куска и перезапись главы одной транзакцией. Находки глоссария повтора в глоссарий не
 * идут: куски после повторённого уже переведены по прежнему (Р18). Модели - запуска или одна
 * модель перевода, заданная повтором.
 */
@Injectable()
export class ChunkRetryHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly rewrites: ChunkRewriteService,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  /**
   * «Продолжить» повтора - одна задача на кусок с этапа, записанного в попытке. Кусок - по задаче
   * своей операции (`LlmTask.chunkId`, выборка по операции), а не поиском по JSON попытки.
   */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const chunkId = await this.chunkOf(op.id);
    if (!chunkId) return [];
    const chunk = await this.prisma.translationChunk.findUnique({
      where: { id: chunkId },
      select: {
        id: true,
        retry: true,
        runLanguage: { select: { language: true, run: { select: { operationId: true } } } },
      },
    });
    if (!chunk || !retryOpen(retryOf(chunk.retry))) return [];
    const { language, run } = chunk.runLanguage;
    return [retryTaskInput(chunk.id, op.id, run.operationId, language)];
  }

  /**
   * Запуск, к которому относится повтор, идёт - продолжать нельзя: шаг запуска переводит тот же
   * язык. Замок строки операции запуска - после строки повтора (её держит запись «продолжить»).
   */
  async onResumed(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    if (!op.translationRunId) return;
    const run = await tx.translationRun.findUnique({
      where: { id: op.translationRunId },
      select: { operationId: true },
    });
    if (run) await assertRunStopped(tx, run.operationId);
    // Причина прошлой паузы снимается: попытка идёт дальше.
    const chunkId = await this.chunkOf(op.id, tx);
    if (chunkId) await setRetryReason(tx, chunkId, op.id, null, []);
  }

  /** Отменённый повтор - попытка закрыта той же транзакцией: иначе кусок навсегда «повтор идёт». */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    const chunkId = await this.chunkOf(op.id, tx);
    if (chunkId) await markRetryFailed(tx, chunkId, op.id, RETRY_CANCELLED);
  }

  /** Кусок операции повтора - по её задаче (одна задача на кусок, ставит ручка повтора). */
  private async chunkOf(
    operationId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    const task = await db.llmTask.findFirst({
      where: { operationId, kind: TRANSLATION_RETRY_KIND, chunkId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { chunkId: true },
    });
    return task?.chunkId ?? null;
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const chunkId = task.chunkId ?? '';
    const chunk = await this.prisma.translationChunk.findUnique({
      where: { id: chunkId },
      select: RETRY_CHUNK_SELECT,
    });
    const retry = chunk ? retryOf(chunk.retry) : null;
    // Кусок удалили (каскад версии), правили руками или повтор сменился другим - этой попытки нет.
    if (!chunk || !retry || retry.operationId !== task.operationId || !retryOpen(retry)) {
      return this.finish(task.operationId);
    }
    const lang = chunk.runLanguage;
    const { run } = lang;
    const source = await this.prisma.chapter.findUnique({
      where: {
        bookVersionId_number: { bookVersionId: run.bookVersionId, number: chunk.chapterNumber },
      },
      select: { content: true },
    });
    // Главу исходника правили после нарезки: куски не те, повтор их не пересобирает (Р13).
    if (!source || !chunksOfChapter(source.content, [chunk])) {
      return this.fail(task.operationId, chunk.id, DRAFT_FLAG_REASONS.SOURCE_CHANGED);
    }
    if (retry.status === 'flagged' && !retry.blocks) {
      // Перевода нет (`CHUNK_TOO_LONG`, ответ не по форме): кусок остаётся прежним.
      return this.fail(task.operationId, chunk.id, retry.flagReason ?? 'CHUNK_UNTRANSLATED');
    }
    if (retry.status === 'pending' || retry.status === 'translated') {
      return this.step(task, ctx, chunk, retry, source.content);
    }
    await ctx.renewLease();
    const result = await this.rewrites.apply(chunk.id, {
      kind: 'retry',
      operationId: task.operationId,
    });
    // Подмены не было (попытку сняли под замком) - попытка закрывается с причиной, а не висит.
    if (!result.applied) return this.fail(task.operationId, chunk.id, RETRY_NOT_APPLIED);
    return this.finish(task.operationId);
  }

  private async step(
    task: LlmTask,
    ctx: LlmTaskContext,
    chunk: RetryChunk,
    retry: ChunkRetry,
    content: string,
  ): Promise<LlmTaskStepResult> {
    const lang = chunk.runLanguage;
    const { run } = lang;
    const [chunks, context] = await Promise.all([
      this.prisma.translationChunk.findMany({
        where: { runLanguageId: lang.id, chapterNumber: chunk.chapterNumber },
        orderBy: { chunkIndex: 'asc' },
        select: CHUNK_STEP_SELECT,
        take: RUN_CHAPTER_CHUNKS_MAX,
      }),
      chunkStepContext(this.prisma, run.dossierId, lang.glossaryId),
    ]);
    const own = retryStepChunk(chunk, retry);
    const input: ChunkStepInput = {
      llm: this.llm,
      operationId: task.operationId,
      ctx,
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      chapterNumber: chunk.chapterNumber,
      layout: splitChapter(content),
      chunks: chunks.map((c) => (c.id === own.id ? own : c)),
      dossier: context.dossier,
      glossary: context.glossary,
      models: (stage) =>
        stage === TRANSLATE_STAGE && retry.requestedModel
          ? { model: retry.requestedModel, fallbacks: [] }
          : runStageModels(run.operation.settingsSnapshot, run.stageModels, stage),
    };
    const store = retryStore(this.prisma, chunk.id, task.operationId);
    const result =
      retry.status === 'pending'
        ? await translateChunk(input, own, store)
        : await checkChunk(input, own, store);
    if (result.kind === 'no_provider') {
      // Этап и модели, отказавшие по политике данных, - в попытку той же транзакцией, что пауза:
      // выход - повтор с другой моделью этапа (как у языка запуска).
      const tried = await this.llm.stageCallModels(result.stage, result.models);
      await this.tasks.stopOrRepause(task.operationId, 'NO_COMPLIANT_PROVIDER', (tx) =>
        setRetryReason(tx, chunk.id, task.operationId, noProviderReason(result.stage), tried),
      );
    }
    return { kind: 'continue' };
  }

  /** Попытка не подменяет кусок: причина - в попытке, операция закрыта. */
  private async fail(
    operationId: string,
    chunkId: string,
    reason: string,
  ): Promise<LlmTaskStepResult> {
    await this.prisma.$transaction((tx) => markRetryFailed(tx, chunkId, operationId, reason));
    return this.finish(operationId);
  }

  private async finish(operationId: string): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(operationId);
    return { kind: 'done' };
  }

  /** Отказ по деньгам или провайдерам - пауза операции повтора; попытка ждёт «продолжить». */
  private async onFailed(task: LlmTask, reason: string): Promise<void> {
    await this.tasks.pauseOperation(task.operationId, PAUSE_BY_FAILURE[reason] ?? 'STEP_FAILED');
  }
}
