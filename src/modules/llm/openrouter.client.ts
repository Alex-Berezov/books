import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LlmBudgetService, SettleInput } from './llm-budget.service';
import { parsePrice } from './llm-models.service';
import { LlmConfig } from './llm.config';
import { LlmError, llmDisabled } from './llm.errors';

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Модель вызова с ценой на момент вызова (решение арбитра `F05 | F05-1`, Р-А): резерв без цены
 * не считается (Р24). Резерв и факт одной попытки считаются по одному этому объекту.
 */
export interface LlmCallModel {
  id: string;
  /** Долларов за токен. */
  inputPrice: Prisma.Decimal;
  outputPrice: Prisma.Decimal;
  structuredOutputs: boolean;
  /**
   * Задан, если цена взята из потолка `maxPricePerMTok` этапа (у модели нет фиксированной):
   * уходит провайдеру как `provider.max_price`, иначе резерв не верхняя граница (Р-В).
   */
  maxPricePerMTok?: Prisma.Decimal;
}

export interface LlmChatRequest {
  operationId: string;
  stage: string;
  /** Основная модель первой, дальше запасные по порядку. */
  models: LlmCallModel[];
  messages: LlmChatMessage[];
  temperature: number | null;
  maxTokens: number;
  /** Ответ - JSON по схеме: схема уходит в `response_format`, где модель её принимает. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Зовётся перед каждой попыткой (исполнитель продлевает аренду); бросило - вызова нет. */
  beforeAttempt?: () => Promise<void> | void;
  /**
   * Внешнее прерывание (остановка исполнителя `F05-1w`): вызов не повторяется и не считается
   * `timeout`; до отправки - факт 0, после - факт = резерв (Р-Б). Отказ - `LLM_ABORTED`.
   */
  signal?: AbortSignal;
  /** Задача исполнителя: пишется в `LlmCall.taskId`. */
  taskId?: string | null;
}

export interface LlmChatResult {
  callId: string;
  content: string;
  /** Разобранный JSON, если был задан `jsonSchema`. */
  json?: unknown;
  model: string;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: Prisma.Decimal;
}

interface OpenRouterChatBody {
  model?: unknown;
  provider?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
  error?: { code?: unknown; message?: unknown };
}

/** Повторов на модель для сети, 5xx и 429 на последней модели. */
const MAX_ATTEMPTS_PER_MODEL = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;

/**
 * Символов на токен для латиницы и кириллицы - для сверки с контекстом модели и для входа,
 * которого в запросе ещё нет. Резерв считает вход сверху (токен на символ, `estimateInputTokens`)
 * и этим числом не пользуется. Калибровка по `usage.prompt_tokens` - `F05-R`.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Оценка токенов входа без токенизатора: токен на символ плюс служебные токены сообщения
 * (решение арбитра `F05 | F05-1`, Р-Д). Оценка сверху для латиницы и кириллицы - источники
 * перевода по D8; не строгая по байтам, для других письменностей не проверена. Калибровка по
 * `usage.prompt_tokens` - в `F05-R`.
 */
export function estimateInputTokens(
  request: Pick<LlmChatRequest, 'messages' | 'jsonSchema'>,
): number {
  const messages = request.messages.reduce((sum, m) => sum + m.content.length + 16, 0);
  // Схема ответа уходит провайдеру в `response_format` и тоже оплачивается как вход.
  const schema = request.jsonSchema ? JSON.stringify(request.jsonSchema.schema).length : 0;
  return messages + schema;
}

/**
 * Коды отказа до соединения: запрос до провайдера не дошёл и стоить денег не мог (Р-Б).
 * Всё прочее - таймаут, обрыв, `ECONNRESET`, TLS, неизвестный код - факт = резерв.
 */
const BEFORE_CONNECT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type AttemptOutcome =
  | { kind: 'ok'; result: LlmChatResult }
  | { kind: 'retry'; errorClass: string; nextModel: boolean }
  | { kind: 'next_model'; errorClass: string };

/**
 * Клиент OpenRouter на глобальном `fetch` (Р2). Повторы и переход на запасную модель - только
 * здесь, скрытых нет. Строка `LlmCall` - на каждую попытку, факт по ней пишется всегда, даже
 * если вызывающий потерял задачу: деньги у провайдера уже потрачены.
 *
 * 🔴 В каждом запросе `provider.data_collection = "deny"` (Р7): текст книги не уходит
 * провайдерам, которые хранят или учатся на запросах.
 */
@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);

  constructor(
    private readonly config: LlmConfig,
    private readonly budget: LlmBudgetService,
  ) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    if (!this.config.enabled()) throw llmDisabled();
    if (request.models.length === 0) {
      throw new LlmError('LLM_PROVIDER_ERROR', `Stage "${request.stage}" has no models`);
    }

    const inputTokens = estimateInputTokens(request);
    const noCompliant: string[] = [];
    let attempt = 0;
    let lastError = '';

    for (let m = 0; m < request.models.length; m++) {
      const model = request.models[m];
      const isLast = m === request.models.length - 1;
      for (let tryNo = 1; tryNo <= MAX_ATTEMPTS_PER_MODEL; tryNo++) {
        if (tryNo > 1) await this.sleep(backoffMs(tryNo - 1), request.signal);
        throwIfAborted(request.signal);
        attempt += 1;
        const outcome = await this.attempt(request, model, attempt, inputTokens);
        if (outcome.kind === 'ok') return outcome.result;
        lastError = outcome.errorClass;
        if (outcome.kind === 'next_model') {
          if (outcome.errorClass === 'no_compliant_provider') noCompliant.push(model.id);
          break;
        }
        // 429 при наличии запасной - сразу на неё (`tech.md` §3); на последней - повтор.
        if (outcome.nextModel && !isLast) break;
      }
    }

    if (noCompliant.length === request.models.length) {
      throw new LlmError(
        'LLM_NO_COMPLIANT_PROVIDER',
        `No provider complies with the data policy for: ${noCompliant.join(', ')}`,
      );
    }
    throw new LlmError(
      'LLM_UNAVAILABLE',
      `All models failed for stage "${request.stage}" (last: ${lastError})`,
    );
  }

  private async attempt(
    request: LlmChatRequest,
    model: LlmCallModel,
    attempt: number,
    inputTokens: number,
  ): Promise<AttemptOutcome> {
    await request.beforeAttempt?.();
    throwIfAborted(request.signal);

    // Тело собирается до резерва: ошибка сериализации - ошибка вызывающего, а не сети;
    // считать её резервом с повтором нельзя, и резерв без вызова не остаётся висеть.
    const payload = JSON.stringify(this.buildBody(request, model));
    const estimate = model.inputPrice
      .mul(inputTokens)
      .add(model.outputPrice.mul(request.maxTokens));
    const { callId } = await this.budget.reserve({
      operationId: request.operationId,
      stage: request.stage,
      requestedModel: model.id,
      attempt,
      estimateUsd: estimate,
      taskId: request.taskId ?? null,
    });

    const startedAt = Date.now();
    const settle = (patch: Omit<SettleInput, 'durationMs'>) =>
      this.budget.settle(callId, { ...patch, durationMs: Date.now() - startedAt });
    const zero = new Prisma.Decimal(0);

    if (request.signal?.aborted) {
      // Прервано между резервом и отправкой: наружу ничего не ушло, факт 0 (Р-Б).
      await settle({ costUsd: zero, costEstimated: false, errorClass: 'aborted' });
      throw aborted();
    }
    const timeout = AbortSignal.timeout(this.config.callTimeoutMs());
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey() ?? ''}`,
          'Content-Type': 'application/json',
          'X-Title': 'Bibliaris',
        },
        body: payload,
        signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        // Внешнее прерывание после отправки: провайдер мог списать деньги - факт = резерв,
        // и это не `timeout`: повтора нет, процесс останавливается.
        await settle({ costUsd: estimate, costEstimated: true, errorClass: 'aborted' });
        throw aborted();
      }
      if (isLocalFailure(error)) {
        // Запрос не собран (адрес без схемы, недопустимый заголовок): наружу ничего не ушло,
        // факт 0, и повтор не поможет - это ошибка настройки, а не сети.
        await settle({ costUsd: zero, costEstimated: false, errorClass: 'local' });
        this.warn(request.stage, model.id, attempt, 'local');
        throw new LlmError('LLM_PROVIDER_ERROR', 'OpenRouter request could not be built');
      }
      if (isBeforeConnect(error)) {
        // Запрос не ушёл: денег провайдер не взял, факт 0 (Р-Б).
        await settle({ costUsd: zero, costEstimated: false, errorClass: 'connect' });
        this.warn(request.stage, model.id, attempt, 'connect');
        return { kind: 'retry', errorClass: 'connect', nextModel: false };
      }
      // Таймаут или обрыв на нашей стороне: провайдер мог довести генерацию и списать деньги,
      // поэтому факт = резерв (верхняя граница), а не ноль.
      const errorClass = isAbort(error) ? 'timeout' : 'network';
      await settle({ costUsd: estimate, costEstimated: true, errorClass });
      this.warn(request.stage, model.id, attempt, errorClass);
      return { kind: 'retry', errorClass, nextModel: false };
    }

    const body = await readJson(res);
    if (body === null && request.signal?.aborted) {
      // Тело оборвано остановкой. Ответ 200 - генерация могла пройти, факт = резерв; HTTP-отказ -
      // до генерации, факт 0, как у отказа с прочитанным телом (Р-Б).
      await settle({
        costUsd: res.ok ? estimate : zero,
        costEstimated: res.ok,
        errorClass: 'aborted',
      });
      throw aborted();
    }
    if (res.ok && body === null) {
      // Ответ 200, но тело оборвалось или не JSON: генерация могла пройти - факт = резерв,
      // и это сетевой отказ с повтором, а не ошибка содержания.
      await settle({ costUsd: estimate, costEstimated: true, errorClass: 'body_read' });
      this.warn(request.stage, model.id, attempt, 'body_read');
      return { kind: 'retry', errorClass: 'body_read', nextModel: false };
    }
    const reportedCost = parsePrice(body?.usage?.cost);

    if (!res.ok || body?.error) {
      const status = res.ok ? errorStatus(body) : res.status;
      // HTTP-отказ - до генерации: резерв снимается, факт = 0 или то, что прислал провайдер.
      // Ошибка в теле ответа 200 - сбой уже после начала обработки: токены могли списать,
      // поэтому без `usage.cost` факт = резерв (верхняя граница), как у таймаута.
      const midStream = res.ok;
      await settle({
        costUsd: reportedCost ?? (midStream ? estimate : zero),
        costEstimated: midStream && !reportedCost,
        errorClass: `http_${status}`,
      });
      this.warn(request.stage, model.id, attempt, `http_${status}`);
      if (status === 402) {
        throw new LlmError('LLM_INSUFFICIENT_FUNDS', 'OpenRouter balance is insufficient');
      }
      const noEndpoints = noEndpointsReason(status, body);
      if (noEndpoints) return { kind: 'next_model', errorClass: noEndpoints };
      if (status === 429) return { kind: 'retry', errorClass: 'http_429', nextModel: true };
      if (status === 408 || status >= 500) {
        return { kind: 'retry', errorClass: `http_${status}`, nextModel: false };
      }
      throw new LlmError(
        'LLM_PROVIDER_ERROR',
        `OpenRouter rejected the request for ${model.id} (HTTP ${status})`,
      );
    }

    const promptTokens = toInt(body?.usage?.prompt_tokens);
    const completionTokens = toInt(body?.usage?.completion_tokens);
    const fact = factCost(reportedCost, promptTokens, completionTokens, model, estimate);
    const actualModel = typeof body?.model === 'string' ? body.model : model.id;
    const provider = typeof body?.provider === 'string' ? body.provider : null;
    await settle({
      costUsd: fact.cost,
      costEstimated: fact.estimated,
      actualModel,
      provider,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
    });

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LlmError('LLM_INVALID_RESPONSE', `Model ${actualModel} returned no content`);
    }
    const result: LlmChatResult = {
      callId,
      content,
      model: actualModel,
      provider,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      costUsd: fact.cost,
    };
    if (request.jsonSchema) {
      // Невалидный JSON - ошибка содержания наверх: повтор с замечанием решает этап, не клиент.
      try {
        result.json = JSON.parse(content) as unknown;
      } catch {
        throw new LlmError('LLM_INVALID_RESPONSE', `Model ${actualModel} returned invalid JSON`);
      }
    }
    return { kind: 'ok', result };
  }

  private buildBody(request: LlmChatRequest, model: LlmCallModel): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: model.id,
      messages: request.messages,
      max_tokens: request.maxTokens,
      provider: model.maxPricePerMTok
        ? {
            data_collection: 'deny',
            max_price: {
              prompt: Number(model.maxPricePerMTok.toFixed(8)),
              completion: Number(model.maxPricePerMTok.toFixed(8)),
            },
          }
        : { data_collection: 'deny' },
      usage: { include: true },
    };
    if (request.temperature !== null) body.temperature = request.temperature;
    if (request.jsonSchema && model.structuredOutputs) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          strict: true,
          schema: request.jsonSchema.schema,
        },
      };
    }
    return body;
  }

  /** Только этап, модель, попытка и класс отказа: ни ключа, ни текста запроса и ответа. */
  private warn(stage: string, model: string, attempt: number, errorClass: string): void {
    this.logger.warn(
      `LLM call failed: stage=${stage} model=${model} attempt=${attempt} error=${errorClass}`,
    );
  }

  /** Пауза между повторами; внешнее прерывание её обрывает (повтор после неё не начнётся). */
  protected sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

function aborted(): LlmError {
  return new LlmError('LLM_ABORTED', 'LLM call aborted');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw aborted();
}

function backoffMs(retry: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (retry - 1), BACKOFF_MAX_MS);
}

/**
 * Таймаут `AbortSignal.timeout` приходит как `DOMException`, а не `Error` в каждом окружении
 * (`instanceof` ломается между realm'ами), поэтому сверка по имени.
 */
function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * `TypeError` без `cause` - запрос не собран у нас (undici кладёт сетевую причину в `cause`,
 * её разбирает `isBeforeConnect`).
 */
function isLocalFailure(error: unknown): boolean {
  return (
    (error as { name?: unknown } | null)?.name === 'TypeError' &&
    (error as { cause?: unknown }).cause === undefined
  );
}

/** Только по `cause.code` из белого списка; текст ошибки не разбирается (Р-Б). */
function isBeforeConnect(error: unknown): boolean {
  if (isAbort(error)) return false;
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && BEFORE_CONNECT_CODES.has(code);
}

async function readJson(res: Response): Promise<OpenRouterChatBody | null> {
  try {
    return (await res.json()) as OpenRouterChatBody;
  } catch {
    return null;
  }
}

function errorStatus(body: OpenRouterChatBody | null): number {
  const code = Number(body?.error?.code);
  return Number.isInteger(code) && code >= 400 ? code : 502;
}

/**
 * 404 «нет подходящих эндпоинтов»: повтор той же модели бессмыслен - сразу запасная.
 * «Под политику данных» (Р7) - отдельный класс: только он даёт `LLM_NO_COMPLIANT_PROVIDER`.
 * Прочие (потолок `max_price`, неподдержанные параметры) кончаются `LLM_UNAVAILABLE`, чтобы
 * админа не отправили смотреть политику данных, когда дело в цене.
 */
function noEndpointsReason(status: number, body: OpenRouterChatBody | null): string | null {
  if (status !== 404) return null;
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  if (/data policy/i.test(message)) return 'no_compliant_provider';
  return /no endpoints found/i.test(message) ? 'no_endpoints' : null;
}

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Факт вызова: `usage.cost` провайдера; нет поля - токены × цена этой попытки (та же, что
 * в резерве, Р-А); нет и токенов - факт = резерв. Два последних случая помечаются оценкой.
 */
function factCost(
  reported: Prisma.Decimal | null,
  promptTokens: number | null,
  completionTokens: number | null,
  model: LlmCallModel,
  reserve: Prisma.Decimal,
): { cost: Prisma.Decimal; estimated: boolean } {
  if (reported) return { cost: reported, estimated: false };
  if (promptTokens !== null && completionTokens !== null) {
    return {
      cost: model.inputPrice.mul(promptTokens).add(model.outputPrice.mul(completionTokens)),
      estimated: true,
    };
  }
  return { cost: reserve, estimated: true };
}
