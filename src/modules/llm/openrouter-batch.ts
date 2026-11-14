import { createHash } from 'crypto';
import { isRecord } from '../../shared/prisma/json-record.util';
import type { BatchCallRow } from './llm-budget.service';
import type { LlmCallModel, LlmChatRequest, OpenRouterChatBody } from './openrouter.client';

/**
 * Чистые правила вызова моделей `:batch` через Batch API OpenRouter (решения арбитра 14.11.2026,
 * `2026-11-14-llm-batch-models`): формы ответа батча, отпечаток запроса, когда батч отправлять
 * заново. Походы наружу и деньги - в `OpenRouterClient`.
 */

/** Батч OpenRouter (`GET /api/v1/batches/{id}`): только то, что читает клиент. */
export interface OpenRouterBatch {
  id?: unknown;
  status?: string;
  provider?: unknown;
  usage?: { cost?: unknown } | null;
  results?: unknown;
  error?: unknown;
}

/**
 * Батч кончился: `completed` - ответ, `failed`/`expired`/`cancelled` - отказ. Любой другой статус -
 * батч открыт (до срока `BATCH_DEADLINE_MS`): незнакомый статус, сочтённый отказом, оплатил бы
 * запасную, а батч доработал бы и списал деньги мимо учёта (решение арбитра 14.11.2026, п.1а).
 */
export const BATCH_FINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

/** Известные статусы работы батча; открытый статус вне этого набора пишется в журнал как незнакомый. */
export const BATCH_KNOWN_OPEN = new Set(['validating', 'in_progress', 'finalizing']);

/**
 * Ответ батча забран этапом: `consumed` - годный, `unusable` - оплачен, но без содержания по форме.
 * Забранный ответ второй раз деньгами не считается: факт уже ушёл в стоимость этапа.
 */
export const BATCH_CONSUMED = 'consumed';
export const BATCH_UNUSABLE = 'unusable';

/**
 * Батч точно не создан (нет соединения, отправку отвергли, прервано до отправки): денег нет,
 * и такая строка повтор не держит - тот же запрос уходит снова, в любой задаче.
 */
export const BATCH_NOT_SUBMITTED = 'not_submitted';

/**
 * Сколько ждать батч, прежде чем считать его пропавшим: окно Batch API - 24 ч, у Vertex - до 96 ч
 * (документация OpenRouter), плюс запас. Дольше - отказ модели с фактом = резерв.
 */
export const BATCH_DEADLINE_MS = 100 * 3600_000;

/** Таймаут одного опроса батча: ответ - короткий JSON статуса, а уборка опрашивает их подряд. */
export const BATCH_POLL_TIMEOUT_MS = 15_000;

/**
 * Исход законченного батча. `billed` - модель, возможно, отработала и деньги списаны, а ответа нет
 * (свой результат не найден или нечитаем): факт - `usage.cost` или резерв с пометкой оценки, а не 0
 * (решение арбитра 14.11.2026, п.3).
 */
export type BatchResult =
  | { kind: 'answer'; body: OpenRouterChatBody | null }
  | { kind: 'failed'; errorClass: string; billed: boolean };

/**
 * Ответ запроса `customId` в законченном батче. У каждого результата - `response` или `error`;
 * тело ответа - сам ответ `chat/completions` или он же в `body`. Батч `failed`/`expired`/`cancelled`,
 * запрос с `error` или кодом ответа от 400 - отказ модели: дальше запасная, как у синхронного 404.
 */
export function batchResult(batch: OpenRouterBatch, customId: string): BatchResult {
  if (batch.status !== 'completed') {
    return { kind: 'failed', errorClass: `batch_${batch.status}`, billed: false };
  }
  const results = Array.isArray(batch.results) ? batch.results.filter(isRecord) : [];
  const item =
    results.find((r) => r.custom_id === customId) ??
    (results.length === 1 ? results[0] : undefined);
  if (!item) return { kind: 'failed', errorClass: 'batch_result_missing', billed: true };
  // Отказ запроса самим поставщиком - без генерации; деньги - только если батч их назвал.
  if (item.error) return { kind: 'failed', errorClass: 'batch_request_failed', billed: false };
  const response = item.response;
  if (!isRecord(response))
    return { kind: 'failed', errorClass: 'batch_result_missing', billed: true };
  const code = Number(response.status_code);
  if (Number.isInteger(code) && code >= 400) {
    return { kind: 'failed', errorClass: `batch_http_${code}`, billed: false };
  }
  const inner = response.choices === undefined ? response.body : undefined;
  const body = isRecord(inner) ? inner : response;
  return { kind: 'answer', body: body as OpenRouterChatBody };
}

/** Batch API берёт базовое имя модели и сам находит её вариант `:batch` (живая проба 14.11.2026). */
export function batchBaseModel(id: string): string {
  return id.endsWith(':batch') ? id.slice(0, -':batch'.length) : id;
}

/**
 * Модель идёт батчем, только если её обслуживает один Batch API (`LlmCallModel.batch` из каталога)
 * и она явно выбрана вариантом `:batch`: исключение из Р7 (запрос без `data_collection: deny`)
 * - только по явной отметке (решение арбитра 14.11.2026).
 */
export function isExplicitBatch(model: LlmCallModel): boolean {
  return model.batch === true && model.id.endsWith(':batch');
}

/**
 * Отпечаток запроса батча: этап, модель и тело; ищется в пределах операции. Повтор шага с тем же
 * входом - в той же задаче или в новой после «продолжить» - находит отправленный батч; другой
 * вход - новый батч. В базу уходит только хэш.
 */
export function batchKeyOf(stage: string, modelId: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ stage, modelId, body })).digest('hex');
}

/**
 * Батч этого запроса отправляется заново, если прежний не создан вовсе, или если он кончился
 * отказом или неразборчивым ответом и спрашивает уже другая задача - после паузы и «продолжить»
 * админ просит повторить. Та же задача получает прежний исход: повтор шага не платит второй раз.
 */
export function resubmits(row: BatchCallRow, request: Pick<LlmChatRequest, 'taskId'>): boolean {
  if (row.batchStatus === BATCH_NOT_SUBMITTED) return true;
  const failed = row.reserveReleasedAt !== null && row.errorClass !== null;
  return (failed || row.batchStatus === BATCH_UNUSABLE) && row.taskId !== request.taskId;
}
