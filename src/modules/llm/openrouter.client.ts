import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BatchCallRow, LlmBudgetService, SettleInput } from './llm-budget.service';
import { parsePrice } from './llm-models.service';
import { LlmConfig } from './llm.config';
import { LlmBatchPendingError, LlmError, LlmTruncatedError, llmDisabled } from './llm.errors';
import {
  BATCH_CONSUMED,
  BATCH_DEADLINE_MS,
  BATCH_FINAL,
  BATCH_KNOWN_OPEN,
  BATCH_NOT_SUBMITTED,
  BATCH_POLL_TIMEOUT_MS,
  BATCH_UNUSABLE,
  batchBaseModel,
  batchKeyOf,
  BatchResult,
  batchResult,
  isExplicitBatch,
  OpenRouterBatch,
  resubmits,
} from './openrouter-batch';

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
  /**
   * Модель только Batch API (`LlmModelInfo.batchOnly`): вызов уходит отложенным батчем на один
   * запрос, а не в `/chat/completions` (решение арбитра 14.11.2026, `2026-11-14-llm-batch-models`).
   */
  batch?: true;
}

/** Схема ответа вызова. */
export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  /**
   * Схема только в тексте запроса, без `response_format`: строгую грамматику такой схемы модель
   * не компилирует (сводка досье на Claude - 400 «compiled grammar is too large»; решение арбитра
   * `F05 | F05-R`, Р1). Ответ сверяет вызывающий, как у модели без `structured_outputs`.
   */
  textOnly?: boolean;
}

export interface LlmChatRequest {
  operationId: string;
  stage: string;
  /** Основная модель первой, дальше запасные по порядку. */
  models: LlmCallModel[];
  messages: LlmChatMessage[];
  temperature: number | null;
  maxTokens: number;
  /** Потолок рассуждений модели внутри `maxTokens` (`reasoning.max_tokens`); нет - без потолка. */
  reasoningMaxTokens?: number;
  /** Таймаут попытки этапа, мс, не ниже общего `LLM_CALL_TIMEOUT_MS`; нет - общий (`LEGACY-479`). */
  callTimeoutMs?: number;
  /** Ответ, оборванный лимитом без JSON, не повторяется - следующая модель (`LEGACY-480`). */
  truncationEndsModel?: boolean;
  /**
   * Ответ - JSON по схеме: схема уходит в `response_format`, где модель её принимает и схема
   * не помечена `textOnly`; иначе модель видит её только в тексте запроса.
   */
  jsonSchema?: LlmJsonSchema;
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
  /** Факт ответа плюс оплаченные оборванные ответы прежних моделей вызова (`truncationEndsModel`). */
  costUsd: Prisma.Decimal;
  /**
   * Ответ получен после обрыва прежней модели (`LEGACY-480`): ответ не по форме повтором с
   * замечанием не исправляется - повтор начал бы цепочку с оборванной модели и оплатил бы её снова
   * (решение арбитра `F05 | F05-13d`).
   */
  afterTruncation?: true;
}

export interface OpenRouterChatBody {
  model?: unknown;
  provider?: unknown;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  error?: { code?: unknown; message?: unknown };
}

/** Повторов на модель для сети, 5xx и 429 на последней модели. */
const MAX_ATTEMPTS_PER_MODEL = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;

/**
 * Символов на токен входа - для сверки с контекстом модели (`stageFit`). Замер `F05-R` по
 * `usage.prompt_tokens`: кусок досье 2,6, сводка 2,51 (разметка блоков и JSON дробятся мельче
 * прозы); с запасом в сторону большего числа токенов (решение арбитра `F05 | F05-R`, Р3).
 * Резерв считает вход сверху (токен на символ, `estimateInputTokens`) и этим числом не пользуется.
 */
export const INPUT_CHARS_PER_TOKEN = 2.5;

/**
 * Символов на токен входа сводки досье (группы, сводка сводок, одиночная сводка): вход - чистый
 * JSON частичных досье, он дробится мельче прозы; 2,26 - замер `F05-R` на JSON глоссария,
 * единственный на таком входе (решение арбитра `F05 | F05-Rb`, Р1). Запаса сверху нет.
 */
export const SUMMARY_INPUT_CHARS_PER_TOKEN = 2.26;

/**
 * Символов на токен ответа - оценка сверху длины ответа в символах из `maxTokens` (вход
 * следующего вызова, которого ещё нет). Больше - значит с запасом (Р3 `F05 | F05-R`).
 */
export const ANSWER_CHARS_PER_TOKEN = 4;

/**
 * Служебный вход роутера сверх запроса: модель без своей цены (`typesafe/jev-router`) дописывает
 * свой промпт - замер `F05-R` ~350 токенов. Добавляется к резерву только модели, оценённой
 * по потолку `maxPricePerMTok`, - иначе резерв не верхняя граница (решение арбитра `F05 | F05-R`, Р6).
 */
const ROUTER_OVERHEAD_INPUT_TOKENS = 1_000;

/** Токены входа для резерва модели: модель по потолку цены - с запасом на служебный вход роутера. */
export function reserveInputTokens(model: LlmCallModel, inputTokens: number): number {
  return model.maxPricePerMTok ? inputTokens + ROUTER_OVERHEAD_INPUT_TOKENS : inputTokens;
}

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

/** Ограда ```json … ``` вокруг всего ответа: без `response_format` модель может обернуть JSON. */
const JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\s*```$/i;

/**
 * JSON ответа; `undefined` - не JSON. Ответ целиком в ограде разбирается без неё: так отвечают
 * модели без строгой схемы (`textOnly`, Р1 `F05 | F05-R`). Текст вокруг JSON не вырезается.
 */
function parseJsonAnswer(content: string): unknown {
  const fenced = JSON_FENCE.exec(content.trim());
  try {
    return JSON.parse(fenced ? fenced[1] : content) as unknown;
  } catch {
    return undefined;
  }
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
  | { kind: 'next_model'; errorClass: string }
  /**
   * Ответ оплачен, но без текста или без разбираемого JSON. `truncated` - оборван лимитом у этапа
   * `truncationEndsModel` (`LEGACY-480`), `invalid` - прочие.
   */
  | { kind: 'truncated'; costUsd: Prisma.Decimal; message: string }
  | { kind: 'invalid'; costUsd: Prisma.Decimal; message: string };

/**
 * Клиент OpenRouter на глобальном `fetch` (Р2). Повторы и переход на запасную модель - только
 * здесь, скрытых нет. Строка `LlmCall` - на каждую попытку, факт по ней пишется всегда, даже
 * если вызывающий потерял задачу: деньги у провайдера уже потрачены.
 *
 * 🔴 В каждом синхронном запросе `provider.data_collection = "deny"` (Р7): текст книги не уходит
 * провайдерам, которые хранят или учатся на запросах. Исключение - модели, явно выбранные
 * вариантом `:batch`: Batch API поле не принимает и хранит запрос 30 дней (решение арбитра
 * 14.11.2026, `openrouter-batch.ts`).
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
    let wasTruncated = false;
    let unusedUsd = new Prisma.Decimal(0);

    // Тело, отпечаток и строка каждой модели `:batch` - один раз на вызов: попытка их не пересчитывает.
    const batches = await this.batchResume(request);
    // С последней модели, чей батч открыт или готов: отказавший батч (своей задачи) пропускается,
    // иначе синхронные модели между ним и ждущим батчем звались бы на каждом опросе (решение
    // арбитра 14.11.2026, итоговый /qa, A).
    const live = batches.filter(
      (b) => b.row && b.row.errorClass === null && !resubmits(b.row, request),
    );
    const resumeAt = live.length > 0 ? live[live.length - 1].index : 0;
    for (let m = resumeAt; m < request.models.length; m++) {
      const model = request.models[m];
      const isLast = m === request.models.length - 1;
      for (let tryNo = 1; tryNo <= MAX_ATTEMPTS_PER_MODEL; tryNo++) {
        if (tryNo > 1) await this.sleep(backoffMs(tryNo - 1), request.signal);
        throwIfAborted(request.signal);
        attempt += 1;
        // Найденное заранее - только первой попытке своей модели: после отправки строка уже другая.
        const found = tryNo === 1 ? (batches.find((b) => b.index === m) ?? null) : null;
        // Имя `:batch` без флага каталога тоже не уходит в `/chat/completions`: там 404 без перехода к
        // запасной - ровно сбой досье 14.11.2026 (итоговый /qa, D); батч-ветка его пропускает.
        const call =
          model.batch || model.id.endsWith(':batch')
            ? this.batchAttempt(request, model, attempt, inputTokens, wasTruncated, found)
            : this.attempt(request, model, attempt, inputTokens);
        const outcome = await call.catch((error: unknown) => {
          // Запрос к запасной после обрыва отвергнут (4xx, не собран): исход как до перехода
          // к ней - иначе повтор шага снова оплатит обрыв (решение арбитра `F05 | F05-13d`,
          // круг 3). Прерывание, деньги и бюджет остаются паузой.
          if (wasTruncated && error instanceof LlmError && error.code === 'LLM_PROVIDER_ERROR') {
            throw new LlmTruncatedError(`${error.message} after a cut-off`, unusedUsd);
          }
          throw error;
        });
        if (outcome.kind === 'ok') {
          const { result } = outcome;
          if (!wasTruncated) return result;
          return { ...result, costUsd: result.costUsd.add(unusedUsd), afterTruncation: true };
        }
        if (outcome.kind === 'invalid' && !wasTruncated) {
          // Ответ не по форме - ошибка содержания наверх: повтор с замечанием решает этап, не клиент.
          throw new LlmError('LLM_INVALID_RESPONSE', outcome.message);
        }
        if (outcome.kind === 'truncated' || outcome.kind === 'invalid') {
          // Оборванный ответ не повторяется: та же модель с тем же входом оборвётся так же. После
          // обрыва и ответ не по форме - отказ без замечания, иначе повтор этапа снова оплатит обрыв.
          wasTruncated = true;
          unusedUsd = unusedUsd.add(outcome.costUsd);
          if (outcome.kind === 'invalid' || isLast) {
            throw new LlmTruncatedError(outcome.message, unusedUsd);
          }
          break;
        }
        lastError = outcome.errorClass;
        if (outcome.kind === 'next_model') {
          if (outcome.errorClass === 'no_compliant_provider') noCompliant.push(model.id);
          break;
        }
        // 429 при наличии запасной - сразу на неё (`tech.md` §3); на последней - повтор.
        if (outcome.nextModel && !isLast) break;
      }
    }

    if (wasTruncated) {
      // После обрыва запасная недоступна: исход как до перехода к ней - ответ не по форме со
      // стоимостью; повтор шага снова оплатил бы обрыв (решение арбитра `F05 | F05-13d`, круг 3).
      throw new LlmTruncatedError(
        `All models after a cut-off failed for stage "${request.stage}" (last: ${lastError})`,
        unusedUsd,
      );
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
    const estimate = reserveEstimate(model, inputTokens, request.maxTokens);
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
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: payload,
        signal: this.callSignal(request),
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
      return refusalOutcome(status, body, model.id);
    }

    const { input: promptTokens, output: completionTokens } = chatTokens(body);
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

    return this.answerOutcome(request, attempt, body, {
      callId,
      model: actualModel,
      provider,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      costUsd: fact.cost,
    });
  }

  /**
   * Исход оплаченного ответа - один на синхронный вызов и батч: текст, JSON по схеме, обрыв
   * лимитом. `paid` - всё, кроме содержания: факт уже записан вызывающим.
   */
  private answerOutcome(
    request: LlmChatRequest,
    attempt: number,
    body: OpenRouterChatBody | null,
    paid: Omit<LlmChatResult, 'content' | 'json'>,
  ): AttemptOutcome {
    const content = body?.choices?.[0]?.message?.content;
    this.logAnswer(request.stage, paid.model, attempt, body, paid.outputTokens, content);
    // Ответ без содержания оплачен: у этапа `truncationEndsModel` оборванный лимитом - свой исход
    // (`LEGACY-480`), остальные - ошибка содержания.
    const unusable = (reason: string): AttemptOutcome =>
      request.truncationEndsModel === true && body?.choices?.[0]?.finish_reason === 'length'
        ? {
            kind: 'truncated',
            costUsd: paid.costUsd,
            message: `Model ${paid.model} answer was cut off by the token limit`,
          }
        : { kind: 'invalid', costUsd: paid.costUsd, message: `Model ${paid.model} ${reason}` };
    if (typeof content !== 'string') return unusable('returned no content');
    const json = request.jsonSchema ? parseJsonAnswer(content) : undefined;
    if (request.jsonSchema && json === undefined) return unusable('returned invalid JSON');
    const result: LlmChatResult = { ...paid, content };
    if (request.jsonSchema) result.json = json;
    return { kind: 'ok', result };
  }

  /**
   * С какой модели цепочки начинать: повтор шага, чей вызов уже ушёл батчем модели `m`, идёт
   * сразу к ней. Модели перед ней этот запрос уже не взяли - заново их звать значило бы платить
   * за них на каждом опросе ждущего батча (решение арбитра 14.11.2026, круг 1 ревью). Обрыва перед
   * найденным батчем не было: после обрыва модель `:batch` не зовётся (`batchAttempt`), поэтому
   * возобновление не теряет `wasTruncated` и оплаченный обрыв (`F05 | F05-13d`).
   */
  private async batchResume(request: LlmChatRequest): Promise<BatchFound[]> {
    if (!request.taskId) return [];
    const found: BatchFound[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < request.models.length; index++) {
      const model = request.models[index];
      if (!isExplicitBatch(model) || model.maxPricePerMTok) continue;
      // Одна модель дважды в цепочке - одна строка: возобновление по первому вхождению, иначе
      // запасные между вхождениями молча пропускались бы (решение арбитра 14.11.2026, G).
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const body = this.batchRequestBody(request, model);
      const key = batchKeyOf(request.stage, model.id, body);
      const row = await this.budget.findBatchCall(request.operationId, key);
      found.push({ index, body, key, row });
    }
    return found;
  }

  /**
   * Попытка модели `:batch` (решение арбитра 14.11.2026, `2026-11-14-llm-batch-models`): батч на один
   * запрос через `/api/v1/batches`. Отпечаток запроса (этап, модель, тело) ищет уже отправленный
   * батч операции: нет - отправка и `LlmBatchPendingError`; есть - его исход. Отмены у Batch API
   * нет, поэтому тот же запрос второй раз не уходит (`resubmits` - единственное исключение).
   */
  private async batchAttempt(
    request: LlmChatRequest,
    model: LlmCallModel,
    attempt: number,
    inputTokens: number,
    afterCutOff: boolean,
    found: BatchFound | null,
  ): Promise<AttemptOutcome> {
    const skip = batchSkipReason(request, model, afterCutOff);
    if (skip) {
      this.warn(request.stage, model.id, attempt, skip);
      return { kind: 'next_model', errorClass: skip };
    }
    await request.beforeAttempt?.();
    throwIfAborted(request.signal);
    const body = found?.body ?? this.batchRequestBody(request, model);
    const key = found?.key ?? batchKeyOf(request.stage, model.id, body);
    const row = found ? found.row : await this.budget.findBatchCall(request.operationId, key);
    if (!row || resubmits(row, request)) {
      return this.submitBatch(request, model, attempt, inputTokens, body, key);
    }
    return this.collectBatch(request, model, attempt, row);
  }

  /**
   * Тело запроса внутри батча: как у синхронного, но базовое имя модели и без `provider`. Batch API
   * отвергает `provider.data_collection` (живая проба 14.11.2026: 400 «Unrecognized key») и не
   * работает под ZDR - явная отметка `:batch` - исключение из Р7 (решение арбитра 14.11.2026).
   * `max_price` в батч не уходит: модель без фиксированной цены батчем не зовётся (`batchAttempt`).
   */
  private batchRequestBody(request: LlmChatRequest, model: LlmCallModel): Record<string, unknown> {
    const body = this.buildBody(request, model);
    delete body.provider;
    body.model = batchBaseModel(model.id);
    return body;
  }

  private async submitBatch(
    request: LlmChatRequest,
    model: LlmCallModel,
    attempt: number,
    inputTokens: number,
    body: Record<string, unknown>,
    key: string,
  ): Promise<AttemptOutcome> {
    const estimate = reserveEstimate(model, inputTokens, request.maxTokens);
    const { callId } = await this.budget.reserve({
      operationId: request.operationId,
      stage: request.stage,
      requestedModel: model.id,
      attempt,
      estimateUsd: estimate,
      taskId: request.taskId ?? null,
      batchKey: key,
    });
    const startedAt = Date.now();
    const settle = (patch: Omit<SettleInput, 'durationMs'>) =>
      this.budget.settle(callId, { ...patch, durationMs: Date.now() - startedAt });
    if (request.signal?.aborted) {
      // Прервано между резервом и отправкой: наружу ничего не ушло, факт 0 (Р-Б).
      await settle({
        costUsd: ZERO,
        costEstimated: false,
        errorClass: 'aborted',
        batchStatus: BATCH_NOT_SUBMITTED,
      });
      throw aborted();
    }
    // Поля до `requests` - первыми: иначе Batch API отвечает 400 (документация OpenRouter).
    const payload = JSON.stringify({
      endpoint: '/v1/chat/completions',
      model: body.model,
      completion_window: '24h',
      requests: [{ custom_id: callId, body }],
    });
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl()}/batches`, {
        method: 'POST',
        headers: this.headers(),
        body: payload,
        signal: this.callSignal(request),
      });
    } catch (error) {
      if (!request.signal?.aborted && isLocalFailure(error)) {
        // Запрос не собран у нас (адрес, заголовок): батча нет, повтор не поможет - ошибка
        // настройки, как у синхронного вызова (решение арбитра 14.11.2026, п.4).
        await settle({
          costUsd: ZERO,
          costEstimated: false,
          errorClass: 'local',
          batchStatus: BATCH_NOT_SUBMITTED,
        });
        this.warn(request.stage, model.id, attempt, 'local');
        throw new LlmError('LLM_PROVIDER_ERROR', 'OpenRouter request could not be built');
      }
      if (!request.signal?.aborted && isBeforeConnect(error)) {
        // Запрос не ушёл: батча нет, денег не взято.
        await settle({
          costUsd: ZERO,
          costEstimated: false,
          errorClass: 'connect',
          batchStatus: BATCH_NOT_SUBMITTED,
        });
        this.warn(request.stage, model.id, attempt, 'batch_connect');
        return { kind: 'retry', errorClass: 'connect', nextModel: false };
      }
      // Батч мог быть создан, а его id не дошёл: заплатим за него без ответа - факт = резерв.
      // Та же модель с тем же запросом не повторяется (отпечаток записан резервом): второй батч
      // оплатил бы тот же запрос дважды.
      await settle({ costUsd: estimate, costEstimated: true, errorClass: 'batch_submit_lost' });
      if (request.signal?.aborted) throw aborted();
      this.warn(request.stage, model.id, attempt, 'batch_submit_lost');
      return { kind: 'next_model', errorClass: 'batch_submit_lost' };
    }
    const answer = (await readJson(res)) as OpenRouterBatch | null;
    const batchId = typeof answer?.id === 'string' && answer.id ? answer.id : null;
    if ((res.ok && !batchId) || res.status === 408 || res.status >= 500) {
      // 2xx без тела или без id, 408 и 5xx: батч мог быть создан (отмены нет) - как потерянный
      // ответ: факт = резерв, сразу запасная, без второй отправки (решение арбитра 14.11.2026, п.2).
      await settle({ costUsd: estimate, costEstimated: true, errorClass: 'batch_submit_lost' });
      this.warn(request.stage, model.id, attempt, 'batch_submit_lost');
      return { kind: 'next_model', errorClass: 'batch_submit_lost' };
    }
    if (!batchId) {
      // HTTP-отказ (4xx): батч не создан, денег не взято.
      const status = res.status;
      await settle({
        costUsd: ZERO,
        costEstimated: false,
        errorClass: `http_${status}`,
        batchStatus: BATCH_NOT_SUBMITTED,
      });
      this.warn(request.stage, model.id, attempt, `batch_http_${status}`);
      return refusalOutcome(status, answer as OpenRouterChatBody | null, model.id);
    }
    const status = typeof answer?.status === 'string' ? answer.status : 'validating';
    if (!(await this.budget.markBatchSubmitted(callId, { batchId, status }))) {
      // Строку уже закрыла чистка зависших (отправка шла дольше её порога): батч живёт без строки,
      // отменить его нельзя - в журнал как сироту, дальше запасная (итоговый /qa, B).
      this.logger.warn(
        `LLM batch orphaned: stage=${request.stage} model=${model.id} call=${callId} batch=${batchId}`,
      );
      return { kind: 'next_model', errorClass: 'batch_orphaned' };
    }
    this.logger.log(
      `LLM batch submitted: stage=${request.stage} model=${model.id} attempt=${attempt} batch=${batchId}`,
    );
    throw new LlmBatchPendingError(batchId, status);
  }

  private async collectBatch(
    request: LlmChatRequest,
    model: LlmCallModel,
    attempt: number,
    row: BatchCallRow,
  ): Promise<AttemptOutcome> {
    if (row.reserveReleasedAt && row.errorClass) {
      // Батч этого запроса уже кончился отказом: в этой задаче тот же запрос не повторяется.
      return { kind: 'next_model', errorClass: row.errorClass };
    }
    if (!row.batchId) {
      // Резерв есть, id батча нет: отправка оборвалась на записи. Чистка зависших закроет строку
      // фактом = резерв, и следующий опрос перейдёт к запасной; до тех пор - ждём.
      throw new LlmBatchPendingError(row.id, 'submit_unconfirmed');
    }
    const state = await this.advanceBatch(row, model, request.signal);
    if (state.kind === 'pending') throw new LlmBatchPendingError(row.batchId, state.status);
    if (state.kind === 'failed') {
      this.warn(request.stage, model.id, attempt, state.errorClass);
      return { kind: 'next_model', errorClass: state.errorClass };
    }
    const tokens = chatTokens(state.body);
    const outcome = this.answerOutcome(request, attempt, state.body, {
      callId: row.id,
      model: typeof state.body?.model === 'string' ? state.body.model : model.id,
      provider: state.provider,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      costUsd: state.costUsd,
    });
    await this.budget.markBatchTaken(
      row.id,
      outcome.kind === 'ok' ? BATCH_CONSUMED : BATCH_UNUSABLE,
    );
    return outcome;
  }

  /**
   * Опрос брошенных батчей чисткой исполнителя: батч, чей шаг больше не придёт (операцию
   * остановили, вход шага сменился), иначе держал бы резерв вечно. Тот же шаг батча, что у
   * этапа (`advanceBatch`); сбой одной строки не останавливает остальные. Возвращает число закрытых.
   */
  async pollOpenBatches(polledBefore: Date, limit: number, signal?: AbortSignal): Promise<number> {
    const rows = await this.budget.openBatchCalls(polledBefore, limit);
    let settled = 0;
    // Группами по BATCH_POLL_PARALLEL: медленный OpenRouter не растягивает проход уборки на минуты.
    for (let i = 0; i < rows.length; i += BATCH_POLL_PARALLEL) {
      if (signal?.aborted) break;
      const group = rows.slice(i, i + BATCH_POLL_PARALLEL);
      const states = await Promise.allSettled(
        group.map((row) => this.advanceBatch(row, null, signal)),
      );
      states.forEach((state, n) => {
        if (state.status === 'fulfilled') {
          if (state.value.kind !== 'pending') settled += 1;
          return;
        }
        const name = state.reason instanceof Error ? state.reason.name : 'unknown';
        this.logger.warn(`LLM batch poll failed: call=${group[n].id} error=${name}`);
      });
    }
    return settled;
  }

  /**
   * Один шаг жизни батча - общий у этапа и чистки. Открыт - отметка опроса (после срока
   * `BATCH_DEADLINE_MS` - отказ); кончился - факт один раз (`settleTerminal`) и исход; нет батча
   * (404/410) - отказ без денег; опрос отвергнут (400, 401, 403...) - отказ с фактом = резерв:
   * батч мог пройти, а прочитать его мы уже не можем. Сеть, 408, 429, 5xx - ждём.
   */
  private async advanceBatch(
    row: BatchCallRow,
    model: LlmCallModel | null,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'pending'; status: string }
    | { kind: 'failed'; errorClass: string }
    | {
        kind: 'answer';
        body: OpenRouterChatBody | null;
        costUsd: Prisma.Decimal;
        provider: string | null;
      }
  > {
    const batchId = row.batchId as string;
    const fetched = await this.fetchBatch(batchId, signal);
    const status = fetched.kind === 'batch' ? (fetched.batch.status ?? 'unknown') : null;
    // Кончился - только явный конечный статус; незнакомый - открыт до срока: отказ по незнакомому
    // оплатил бы запасную при живом батче (решение арбитра 14.11.2026, п.1а).
    // Опрос отвергнут 400/401/403 (ротация ключа, краткий отказ): батч, возможно, работает - ждём до
    // срока, а не платим запасную при живом батче (решение арбитра 14.11.2026, F(а)).
    const refusedWhileLive =
      fetched.kind === 'refused' && POLL_REFUSED_WAIT.has(fetched.httpStatus);
    if (refusedWhileLive) {
      this.logger.warn(
        `LLM batch poll refused, still waiting: call=${row.id} http=${fetched.httpStatus}`,
      );
    }
    if (
      refusedWhileLive ||
      fetched.kind === 'pending' ||
      (status !== null && !BATCH_FINAL.has(status))
    ) {
      if (status !== null && !BATCH_KNOWN_OPEN.has(status)) {
        this.logger.warn(
          `LLM batch has an unknown status, still waiting: call=${row.id} status=${status}`,
        );
      }
      if (Date.now() - row.startedAt.getTime() > BATCH_DEADLINE_MS) {
        return this.failBatch(row, 'batch_timeout', row.reservedUsd);
      }
      // В статус батча - только то, что сказал OpenRouter; сбой опроса статус не меняет.
      await this.budget.touchBatch(row.id, status);
      const seen =
        status ??
        (fetched.kind === 'pending'
          ? fetched.status
          : fetched.kind === 'refused'
            ? `poll_http_${fetched.httpStatus}`
            : 'unknown');
      return { kind: 'pending', status: seen };
    }
    if (fetched.kind === 'gone') return this.failBatch(row, 'batch_gone', ZERO);
    if (fetched.kind === 'refused') {
      return this.failBatch(row, `batch_poll_http_${fetched.httpStatus}`, row.reservedUsd);
    }
    const result = batchResult(fetched.batch, row.id);
    const paid = await this.settleTerminal(row, fetched.batch, result, model);
    if (result.kind === 'failed') return { kind: 'failed', errorClass: result.errorClass };
    // Цена - при каждом чтении: шаг суммирует свои вызовы заново на каждом проходе (`callShaped`),
    // а проход, оборванный ожиданием следующего батча, свою сумму теряет. Деньги бюджета - один
    // раз, в `LlmCall` (решение `F05 | F05-4a`, В7; круг 2 ревью).
    return {
      kind: 'answer',
      body: result.body,
      costUsd: paid,
      provider: typeof fetched.batch.provider === 'string' ? fetched.batch.provider : null,
    };
  }

  /** Отказ батча: факт (0 или резерв) пишется один раз, если строка ещё открыта. */
  private async failBatch(
    row: BatchCallRow,
    errorClass: string,
    cost: Prisma.Decimal,
  ): Promise<{ kind: 'failed'; errorClass: string }> {
    if (!row.reserveReleasedAt) {
      await this.settleBatch(row, {
        costUsd: cost,
        costEstimated: !cost.isZero(),
        errorClass,
        batchStatus: errorClass,
      });
    }
    return { kind: 'failed', errorClass };
  }

  /**
   * Факт законченного батча - один раз (`settle` условием `reserveReleasedAt IS NULL`), вместе со
   * статусом одним `UPDATE`; строка уже закрыта - её факт. `usage.cost` батча на один запрос и есть
   * цена вызова: по запросу Batch API стоимость не даёт (решение арбитра 14.11.2026). Без `cost` -
   * токены по цене модели, без модели (опрос чистки) - резерв, оба помечены оценкой.
   */
  private async settleTerminal(
    row: BatchCallRow,
    batch: OpenRouterBatch,
    result: BatchResult,
    model: LlmCallModel | null,
  ): Promise<Prisma.Decimal> {
    if (row.reserveReleasedAt) return row.costUsd ?? ZERO;
    const reported = parsePrice(batch.usage?.cost);
    const tokens =
      result.kind === 'answer' ? chatTokens(result.body) : { input: null, output: null };
    let fact: { cost: Prisma.Decimal; estimated: boolean };
    if (result.kind === 'failed' && !result.billed)
      fact = { cost: reported ?? ZERO, estimated: false };
    else if (result.kind === 'failed')
      fact = { cost: reported ?? row.reservedUsd, estimated: !reported };
    else if (model) fact = factCost(reported, tokens.input, tokens.output, model, row.reservedUsd);
    else fact = { cost: reported ?? row.reservedUsd, estimated: !reported };
    const won = await this.settleBatch(row, {
      costUsd: fact.cost,
      costEstimated: fact.estimated,
      actualModel:
        result.kind === 'answer' && typeof result.body?.model === 'string'
          ? result.body.model
          : null,
      provider: typeof batch.provider === 'string' ? batch.provider : null,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      errorClass: result.kind === 'failed' ? result.errorClass : null,
      batchStatus: batch.status ?? 'unknown',
    });
    // Строку первым закрыл другой (чистка или параллельный опрос): цена - та, что записана.
    if (!won) return (await this.budget.callCost(row.id)) ?? fact.cost;
    return fact.cost;
  }

  private settleBatch(row: BatchCallRow, patch: Omit<SettleInput, 'durationMs'>): Promise<boolean> {
    return this.budget.settle(row.id, {
      ...patch,
      durationMs: Math.min(Date.now() - row.startedAt.getTime(), MAX_DURATION_MS),
    });
  }

  /**
   * `GET /batches/{id}`: сеть, 408, 429 и 5xx - «ещё ждём»; 404 и 410 - батча больше нет; прочий
   * отказ (400, 401, 403...) - опрос отвергнут. Остановка шага прерывает опрос (`signal`).
   */
  private async fetchBatch(
    batchId: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'pending'; status: string }
    | { kind: 'gone' }
    | { kind: 'refused'; httpStatus: number }
    | { kind: 'batch'; batch: OpenRouterBatch }
  > {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl()}/batches/${encodeURIComponent(batchId)}`, {
        headers: this.headers(),
        signal: withStop(BATCH_POLL_TIMEOUT_MS, signal),
      });
    } catch {
      if (signal?.aborted) throw aborted();
      return { kind: 'pending', status: 'poll_failed' };
    }
    if (res.status === 404 || res.status === 410) return { kind: 'gone' };
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { kind: 'pending', status: `poll_http_${res.status}` };
    }
    if (!res.ok) return { kind: 'refused', httpStatus: res.status };
    const batch = (await readJson(res)) as OpenRouterBatch | null;
    if (!batch) return { kind: 'pending', status: 'poll_body_read' };
    return { kind: 'batch', batch };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey() ?? ''}`,
      'Content-Type': 'application/json',
      'X-Title': 'Bibliaris',
    };
  }

  /**
   * Таймаут этапа - нижняя граница: общий, поднятый окружением выше, действует и на этап (решение
   * арбитра `F05 | F05-13c`, круг 1); остановка шага прерывает вызов.
   */
  private callSignal(request: LlmChatRequest): AbortSignal {
    return withStop(
      Math.max(request.callTimeoutMs ?? 0, this.config.callTimeoutMs()),
      request.signal,
    );
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
    if (request.reasoningMaxTokens !== undefined) {
      body.reasoning = { max_tokens: request.reasoningMaxTokens };
    }
    if (request.jsonSchema && model.structuredOutputs && !request.jsonSchema.textOnly) {
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

  /**
   * Исход ответа (решение арбитра `F05 | F05-12`, второй живой отказ группы): на что ушёл выход -
   * `finish_reason`, токены ответа, из них рассуждения, длина текста в символах; токены входа, взятые
   * поставщиком из кэша, - мерка неизменного префикса промпта (решение арбитра `F05 | F05-14`).
   * Только числа и причина, как у `warn`: ни ключа, ни текста запроса и ответа.
   */
  private logAnswer(
    stage: string,
    model: string,
    attempt: number,
    body: OpenRouterChatBody | null,
    completionTokens: number | null,
    content: unknown,
  ): void {
    const finish = body?.choices?.[0]?.finish_reason;
    const reasoning = toInt(body?.usage?.completion_tokens_details?.reasoning_tokens);
    const cached = toInt(body?.usage?.prompt_tokens_details?.cached_tokens);
    this.logger.log(
      `LLM call answered: stage=${stage} model=${model} attempt=${attempt} ` +
        `finish=${typeof finish === 'string' && /^[a-z_]{1,32}$/.test(finish) ? finish : 'unknown'} ` +
        `completionTokens=${completionTokens ?? 'unknown'} reasoningTokens=${reasoning ?? 'unknown'} ` +
        `cachedTokens=${cached ?? 'unknown'} ` +
        `contentChars=${typeof content === 'string' ? content.length : 'none'}`,
    );
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

const ZERO = new Prisma.Decimal(0);

/** `LlmCall.durationMs` - `int`: возраст долгого батча в него не влезает. */
const MAX_DURATION_MS = 2_147_483_647;

/** Таймаут вызова вместе с остановкой шага: что сработает первым. */
function withStop(timeoutMs: number, stop: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return stop ? AbortSignal.any([timeout, stop]) : timeout;
}

/** Отказы опроса батча, при которых батч, возможно, жив: ждём до срока, а не платим запасную. */
const POLL_REFUSED_WAIT = new Set([400, 401, 403]);

/** Батчей, опрашиваемых уборкой одновременно. */
const BATCH_POLL_PARALLEL = 5;

/** Модель `:batch` цепочки до первой попытки: тело, отпечаток и строка вызова (нет - не отправлялся). */
interface BatchFound {
  index: number;
  body: Record<string, unknown>;
  key: string;
  row: BatchCallRow | null;
}

/**
 * Почему модели `:batch` этот вызов не достаётся (дальше запасная), или `null`. Имя `:batch`, а флага
 * каталога нет (модель снята или каталог недоступен) - звать её некуда; выбрана без явного
 * `:batch` (исключение из Р7 - только по отметке); вне задачи исполнителя (ответ ждать некому);
 * без фиксированной цены (`max_price` в батч не уходит); после обрыва прежней модели цепочки -
 * возобновление на батче потеряло бы оплаченный обрыв (`F05 | F05-13d`, круг 2 ревью).
 */
function batchSkipReason(
  request: LlmChatRequest,
  model: LlmCallModel,
  afterCutOff: boolean,
): string | null {
  if (!model.batch) return 'batch_unknown';
  if (!isExplicitBatch(model)) return 'batch_unmarked';
  if (!request.taskId) return 'batch_needs_task';
  if (model.maxPricePerMTok) return 'batch_no_fixed_price';
  if (afterCutOff) return 'batch_after_truncation';
  return null;
}

/** Резерв попытки: вход сверху (`reserveInputTokens`) плюс весь `maxTokens` выхода. */
function reserveEstimate(
  model: LlmCallModel,
  inputTokens: number,
  maxTokens: number,
): Prisma.Decimal {
  return model.inputPrice
    .mul(reserveInputTokens(model, inputTokens))
    .add(model.outputPrice.mul(maxTokens));
}

/**
 * HTTP-отказ запроса (синхронного или отправки батча) - до генерации, факт уже записан
 * вызывающим: 402 - нет денег (пауза), «нет эндпоинтов» - сразу запасная, 429 - запасная или
 * повтор, 408 и 5xx - повтор, прочее - `LLM_PROVIDER_ERROR` без повтора.
 */
function refusalOutcome(
  status: number,
  body: OpenRouterChatBody | null,
  modelId: string,
): AttemptOutcome {
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
    `OpenRouter rejected the request for ${modelId} (HTTP ${status})`,
  );
}

function chatTokens(body: OpenRouterChatBody | null): {
  input: number | null;
  output: number | null;
} {
  return {
    input: toInt(body?.usage?.prompt_tokens),
    output: toInt(body?.usage?.completion_tokens),
  };
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
