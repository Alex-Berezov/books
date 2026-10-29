import { Prisma, TranslationChunkStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { lockOperationRow, stopOperationRows } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { ChunkVerdict } from '../check/chunk-verdict';
import { ChunkStore, ChunkWrite, costAdded, StepChunk } from '../translate/chunk-steps';
import { TranslatedBlock } from '../translate/translate.format';
import { RUN_TX_OPTIONS } from '../run/translation-run.constants';
import { RETRY_IN_PROGRESS, RUN_ACTIVE } from './chunk-retry.constants';

/** Вид задачи повтора куска - тот же, что резервирует ключ пары исполнителя (`F05-1w`). */
export { TRANSLATION_RETRY_KIND } from '../../llm-worker/llm-task.types';

/**
 * Итог попытки, после которого она больше не идёт: `applied` - кусок подменён ею, `failed` -
 * не подменён (перевода нет, исходник правили, кусок правили руками посреди повтора).
 */
export type ChunkRetryEnd = 'applied' | 'failed';

/**
 * Попытка повтора куска - `TranslationChunk.retry` (решение арбитра `F05 | F05-7v`): поля куска,
 * которые пишут шаги перевода и проверок, своей копией. Кусок не меняется, пока попытка не дошла
 * до конца: провал или лимит посреди повтора не оставляют его `pending` под «продолжить» запуска.
 */
export interface ChunkRetry {
  operationId: string;
  /** Модель перевода попытки, одна без запасных; `null` - модели этапа запуска. */
  requestedModel: string | null;
  status: TranslationChunkStatus | ChunkRetryEnd;
  blocks?: TranslatedBlock[];
  rawResponse?: unknown;
  model?: string | null;
  callId?: string | null;
  verdict?: ChunkVerdict | null;
  flagReason?: string | null;
  /** Факт платных ответов попытки - строкой, как деньги в JSON. */
  costUsd: string;
  attempts: number;
  /**
   * Почему попытка `failed`, или флаг попытки, подменившей кусок; на паузе `NO_COMPLIANT_PROVIDER` -
   * код этапа (как у языка запуска), модели - в `reasonModels`.
   */
  reason?: string | null;
  /** Модели этапа, все отказавшие по политике данных: выход - другая модель. */
  reasonModels?: string[];
}

/** Попытка из строки куска; не той формы - `null`. */
export function retryOf(value: Prisma.JsonValue | null | undefined): ChunkRetry | null {
  if (!isRecord(value)) return null;
  if (typeof value.operationId !== 'string' || typeof value.status !== 'string') return null;
  if (typeof value.costUsd !== 'string' || typeof value.attempts !== 'number') return null;
  return value as unknown as ChunkRetry;
}

export const retryJson = (retry: ChunkRetry): Prisma.InputJsonValue =>
  retry as unknown as Prisma.InputJsonValue;

/** Попытка ещё идёт: этап перевода или проверок. */
export function retryOpen(retry: ChunkRetry | null): retry is ChunkRetry {
  return retry !== null && retry.status !== 'applied' && retry.status !== 'failed';
}

/** Новая попытка операции повтора. */
export function newRetry(operationId: string, requestedModel: string | null): ChunkRetry {
  return { operationId, requestedModel, status: 'pending', costUsd: '0', attempts: 0 };
}

/** Кусок для общих шагов: границы - из строки куска, переводимые поля - из попытки. */
export function retryStepChunk(
  chunk: Omit<StepChunk, 'status' | 'blocks' | 'verdict' | 'model' | 'costUsd'>,
  retry: ChunkRetry,
): StepChunk {
  return {
    id: chunk.id,
    chunkIndex: chunk.chunkIndex,
    firstBlock: chunk.firstBlock,
    lastBlock: chunk.lastBlock,
    words: chunk.words,
    status: retry.status as TranslationChunkStatus,
    blocks: (retry.blocks ?? null) as unknown as Prisma.JsonValue,
    verdict: (retry.verdict ?? null) as unknown as Prisma.JsonValue,
    model: retry.model ?? null,
    costUsd: new Prisma.Decimal(retry.costUsd),
  };
}

/** Поля записи шага поверх попытки; стоимость - прибавкой. */
function merged(retry: ChunkRetry, write: ChunkWrite): ChunkRetry {
  return {
    ...retry,
    ...(write.status ? { status: write.status } : {}),
    ...(write.rawResponse !== undefined ? { rawResponse: write.rawResponse } : {}),
    ...(write.blocks ? { blocks: write.blocks } : {}),
    ...(write.model !== undefined ? { model: write.model } : {}),
    ...(write.callId !== undefined ? { callId: write.callId } : {}),
    ...(write.verdict ? { verdict: write.verdict } : {}),
    costUsd: write.costUsd
      ? new Prisma.Decimal(retry.costUsd).add(write.costUsd).toString()
      : retry.costUsd,
    attempts: retry.attempts + (write.attempt ? 1 : 0),
  };
}

/**
 * Запись шагов повтора в попытку: под замком строки куска, условием «попытка этой операции и
 * всё ещё в статусе `from`» - повтор шага после потерянной аренды и правка руками посреди повтора
 * (она снимает попытку) не перепишут чужое. Флаг попытки счётчиков языка не трогает: их меняет
 * подмена куска (`ChunkRewriteService`).
 */
export function retryStore(db: PrismaService, chunkId: string, operationId: string): ChunkStore {
  const write = (from: TranslationChunkStatus, data: ChunkWrite) =>
    db.$transaction(async (tx) => {
      const current = await lockedRetry(tx, chunkId);
      if (!current || current.operationId !== operationId || current.status !== from) return;
      await tx.translationChunk.update({
        where: { id: chunkId },
        data: { retry: retryJson(merged(current, data)) },
      });
    }, RUN_TX_OPTIONS);
  return {
    write,
    flag: async (from, reason, data) => {
      await db.$transaction(async (tx) => {
        const current = await lockedRetry(tx, chunkId);
        if (!current || current.operationId !== operationId || current.status !== from) return;
        const next = { ...merged(current, data), status: 'flagged' as const, flagReason: reason };
        // Флаг перевода (`CHUNK_TOO_LONG`, ответ не по форме) - у этой попытки перевода нет:
        // текст прошлого перевода попытки, проваленного проверкой, кусок не подменяет.
        if (from === 'pending') {
          delete next.blocks;
          delete next.rawResponse;
        }
        await tx.translationChunk.update({
          where: { id: chunkId },
          data: { retry: retryJson(next) },
        });
      }, RUN_TX_OPTIONS);
    },
  };
}

/**
 * Попытка закончилась без подмены куска: причина - в попытке. Только своя и ещё открытая -
 * правка руками или новый повтор её уже сняли или заменили.
 */
export async function markRetryFailed(
  tx: Prisma.TransactionClient,
  chunkId: string,
  operationId: string,
  reason: string,
): Promise<void> {
  const retry = await lockedRetry(tx, chunkId);
  if (!retry || retry.operationId !== operationId || !retryOpen(retry)) return;
  await tx.translationChunk.update({
    where: { id: chunkId },
    data: { retry: retryJson({ ...retry, status: 'failed', reason }) },
  });
  await chargeRetry(tx, chunkId, retry);
}

/**
 * Попытка закрыта без подмены (отказ, отмена, правка руками, новый повтор поверх): её оплаченные
 * ответы и попытки перевода - в кусок. Стоимость куска - факт всех его ответов (В7).
 */
export async function chargeRetry(
  tx: Prisma.TransactionClient,
  chunkId: string,
  retry: ChunkRetry,
): Promise<void> {
  const paid = new Prisma.Decimal(retry.costUsd);
  if (paid.lte(0) && retry.attempts === 0) return;
  const chunk = await tx.translationChunk.findUniqueOrThrow({
    where: { id: chunkId },
    select: { costUsd: true },
  });
  await tx.translationChunk.update({
    where: { id: chunkId },
    data: {
      ...(paid.gt(0) ? { costUsd: costAdded(chunk.costUsd, paid) } : {}),
      ...(retry.attempts > 0 ? { attempts: { increment: retry.attempts } } : {}),
    },
  });
}

/** Причина остановки идущей попытки своей операции (пауза провайдеров); `null` - снять. */
export async function setRetryReason(
  tx: Prisma.TransactionClient,
  chunkId: string,
  operationId: string,
  reason: string | null,
  reasonModels: string[],
): Promise<void> {
  const retry = await lockedRetry(tx, chunkId);
  if (!retry || retry.operationId !== operationId || !retryOpen(retry)) return;
  await tx.translationChunk.update({
    where: { id: chunkId },
    data: { retry: retryJson({ ...retry, reason, reasonModels }) },
  });
}

/**
 * Операция повтора снимается в транзакции вызывающего (правка руками, новый повтор того же
 * куска): у куска одна попытка. Переход - тот же, что у отмены исполнителя (`stopOperationRows`),
 * но под замками вызывающего, а не своей транзакцией.
 */
export async function cancelRetryOperation(
  tx: Prisma.TransactionClient,
  operationId: string,
): Promise<void> {
  await stopOperationRows(tx, operationId, 'cancelled', null);
}

/**
 * Замки записи куска (повтор и правка руками) в общем порядке: прежняя операция повтора →
 * операция запуска → строка куска. Тот же порядок у «отменить» (операция повтора → кусок) и
 * «продолжить» повтора (операция повтора → операция запуска): встречные кнопки на экране куска
 * ждут друг друга, а не ловят 40P01 (L-019). Попытку сменили между чтением и замком - 409.
 * Запуск идёт - 409 `RUN_ACTIVE`. Возвращает попытку под замком.
 */
export async function lockChunkForWrite(
  tx: Prisma.TransactionClient,
  chunkId: string,
  runOperationId: string,
): Promise<ChunkRetry | null> {
  const seen = await tx.translationChunk.findUnique({
    where: { id: chunkId },
    select: { retry: true },
  });
  const before = retryOf(seen?.retry);
  const open = retryOpen(before) ? before.operationId : null;
  if (open) await lockOperationRow(tx, open);
  await assertRunStopped(tx, runOperationId);
  const retry = await lockedRetry(tx, chunkId);
  if ((retryOpen(retry) ? retry.operationId : null) !== open) {
    throw llmTaskConflict(RETRY_IN_PROGRESS, 'The piece retry changed concurrently, try again');
  }
  return retry;
}

/**
 * Запуск не идёт - под замком строки его операции; иначе 409 `RUN_ACTIVE`. Одно правило на повтор,
 * правку руками и «продолжить» повтора: шаг запуска переводит тот же язык.
 */
export async function assertRunStopped(
  tx: Prisma.TransactionClient,
  runOperationId: string,
): Promise<void> {
  await lockOperationRow(tx, runOperationId);
  const op = await tx.llmOperation.findUnique({
    where: { id: runOperationId },
    select: { status: true },
  });
  if (op?.status === 'active') {
    throw llmTaskConflict(RUN_ACTIVE, 'The translation run is running: pause it first');
  }
}

/** Попытка повтора под замком строки куска; куска нет - `null`. */
export async function lockedRetry(
  tx: Prisma.TransactionClient,
  chunkId: string,
): Promise<ChunkRetry | null> {
  const rows = await tx.$queryRaw<Array<{ retry: Prisma.JsonValue }>>`
    SELECT "retry" FROM "TranslationChunk" WHERE "id" = ${chunkId} FOR UPDATE`;
  return rows.length > 0 ? retryOf(rows[0].retry) : null;
}
