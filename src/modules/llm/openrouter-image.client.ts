import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LlmBudgetService, SettleInput } from './llm-budget.service';
import { parsePrice } from './llm-models.service';
import { LlmConfig } from './llm.config';
import { LlmError, llmDisabled } from './llm.errors';
import {
  aborted,
  callStopSignal,
  isAbort,
  isBeforeConnect,
  isLocalFailure,
  openRouterHeaders,
  throwIfAborted,
} from './openrouter.client';

/**
 * Запрос картинки (`F08-11a`): ручка OpenRouter `POST /images` (документация 23.11.2026,
 * `features/multimodal/image-generation`). Цена у моделей картинок - за картинку, а не за токен,
 * поэтому резерв - потолок цены картинки у вызывающего, факт - `usage.cost` (нет - резерв).
 */
export interface LlmImageRequest {
  operationId: string;
  stage: string;
  /** Основная модель первой, дальше запасные. */
  models: readonly string[];
  prompt: string;
  /** Резерв одной попытки: потолок цены картинки. */
  reserveUsd: Prisma.Decimal;
  /** `aspect_ratio` OpenRouter: `1:1`, `16:9`… */
  aspectRatio: string;
  callTimeoutMs?: number;
  beforeAttempt?: () => Promise<void> | void;
  signal?: AbortSignal;
  taskId?: string | null;
}

export interface LlmImageResult {
  callId: string;
  model: string;
  /**
   * `data[0].b64_json` как пришёл - не проверен: тип, размеры и предел проверяет вызывающий
   * (`checkImageBase64`), до декодирования. `null` - картинки в ответе нет или тело сверх предела.
   */
  base64: unknown;
  /** Тело ответа длиннее `IMAGE_BODY_MAX_BYTES`: дочитано не было, картинка - отказ по размеру. */
  oversize: boolean;
  costUsd: Prisma.Decimal;
}

/**
 * Предел тела ответа: картинка до 12 МБ в base64 (+1/3) и обёртка JSON. Тело длиннее не дочитывается
 * в память - модель не может положить процесс ответом.
 */
export const IMAGE_BODY_MAX_BYTES = 17 * 1024 * 1024;

interface ImagesBody {
  model?: unknown;
  data?: Array<{ b64_json?: unknown }>;
  usage?: { cost?: unknown };
  error?: { code?: unknown };
}

type ImageAttempt = { kind: 'ok'; result: LlmImageResult } | { kind: 'next'; errorClass: string };

/**
 * Клиент картинок OpenRouter. Отдельно от `OpenRouterClient`: другая ручка, другая цена (за
 * картинку) и бинарный ответ. Общее - строка `LlmCall` на каждую попытку с фактом всегда,
 * `provider.data_collection = "deny"` (Р7) и лог без текста запроса и без байтов ответа.
 * Одна попытка на модель: оплата картинки «всё или ничего», отказ генерации - 502 без списания,
 * повтор той же модели с тем же промптом ничего не меняет.
 */
@Injectable()
export class OpenRouterImageClient {
  private readonly logger = new Logger(OpenRouterImageClient.name);

  constructor(
    private readonly config: LlmConfig,
    private readonly budget: LlmBudgetService,
  ) {}

  async generate(request: LlmImageRequest): Promise<LlmImageResult> {
    if (!this.config.enabled()) throw llmDisabled();
    if (request.models.length === 0) {
      throw new LlmError('LLM_PROVIDER_ERROR', `Stage "${request.stage}" has no models`);
    }
    let lastError = '';
    for (let i = 0; i < request.models.length; i++) {
      throwIfAborted(request.signal);
      const outcome = await this.attempt(request, request.models[i], i + 1);
      if (outcome.kind === 'ok') return outcome.result;
      lastError = outcome.errorClass;
    }
    throw new LlmError(
      'LLM_UNAVAILABLE',
      `All models failed for stage "${request.stage}" (last: ${lastError})`,
    );
  }

  private async attempt(
    request: LlmImageRequest,
    model: string,
    attempt: number,
  ): Promise<ImageAttempt> {
    await request.beforeAttempt?.();
    throwIfAborted(request.signal);
    const payload = JSON.stringify({
      model,
      prompt: request.prompt,
      n: 1,
      aspect_ratio: request.aspectRatio,
      resolution: '2K',
      output_format: 'png',
      response_format: 'b64_json',
      provider: { data_collection: 'deny' },
    });
    const reserve = request.reserveUsd;
    const { callId } = await this.budget.reserve({
      operationId: request.operationId,
      stage: request.stage,
      requestedModel: model,
      attempt,
      estimateUsd: reserve,
      taskId: request.taskId ?? null,
    });
    const startedAt = Date.now();
    const settle = (patch: Omit<SettleInput, 'durationMs'>) =>
      this.budget.settle(callId, { ...patch, durationMs: Date.now() - startedAt });
    const zero = new Prisma.Decimal(0);

    if (request.signal?.aborted) {
      await settle({ costUsd: zero, costEstimated: false, errorClass: 'aborted' });
      throw aborted();
    }
    const signal = callStopSignal(this.config, request);
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl()}/images`, {
        method: 'POST',
        headers: openRouterHeaders(this.config),
        body: payload,
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        await settle({ costUsd: reserve, costEstimated: true, errorClass: 'aborted' });
        throw aborted();
      }
      if (isLocalFailure(error)) {
        await settle({ costUsd: zero, costEstimated: false, errorClass: 'local' });
        this.warn(request.stage, model, attempt, 'local');
        throw new LlmError('LLM_PROVIDER_ERROR', 'OpenRouter request could not be built');
      }
      if (isBeforeConnect(error)) {
        await settle({ costUsd: zero, costEstimated: false, errorClass: 'connect' });
        this.warn(request.stage, model, attempt, 'connect');
        return { kind: 'next', errorClass: 'connect' };
      }
      // Таймаут или обрыв после отправки: картинка могла быть сделана и оплачена - факт = резерв.
      const errorClass = isAbort(error) ? 'timeout' : 'network';
      await settle({ costUsd: reserve, costEstimated: true, errorClass });
      this.warn(request.stage, model, attempt, errorClass);
      return { kind: 'next', errorClass };
    }

    if (!res.ok) {
      // Отказ генерации (502) и прочие HTTP-отказы не оплачиваются (оплата «всё или ничего»).
      await res.body?.cancel().catch(() => undefined);
      await settle({ costUsd: zero, costEstimated: false, errorClass: `http_${res.status}` });
      this.warn(request.stage, model, attempt, `http_${res.status}`);
      if (res.status === 402) {
        throw new LlmError('LLM_INSUFFICIENT_FUNDS', 'OpenRouter balance is insufficient');
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500 || res.status === 404) {
        return { kind: 'next', errorClass: `http_${res.status}` };
      }
      throw new LlmError(
        'LLM_PROVIDER_ERROR',
        `OpenRouter rejected the image request for ${model} (HTTP ${res.status})`,
      );
    }

    const read = await readLimitedJson(res, IMAGE_BODY_MAX_BYTES);
    if (read.kind === 'aborted' && request.signal?.aborted) {
      await settle({ costUsd: reserve, costEstimated: true, errorClass: 'aborted' });
      throw aborted();
    }
    if (read.kind === 'oversize') {
      // Ответ 200: картинка сделана и оплачена, но в память не берётся - отказ по размеру.
      await settle({ costUsd: reserve, costEstimated: true, actualModel: model });
      this.warn(request.stage, model, attempt, 'oversize');
      return {
        kind: 'ok',
        result: { callId, model, base64: null, oversize: true, costUsd: reserve },
      };
    }
    if (read.kind !== 'json') {
      // Тело оборвал таймаут вызова - это `timeout`, а не битое тело: так и пишется в `LlmCall`.
      const errorClass = read.kind === 'aborted' ? 'timeout' : 'body_read';
      await settle({ costUsd: reserve, costEstimated: true, errorClass });
      this.warn(request.stage, model, attempt, errorClass);
      return { kind: 'next', errorClass };
    }
    const body = read.body;
    const reported = parsePrice(body?.usage?.cost);
    const actualModel = typeof body?.model === 'string' ? body.model : model;
    await settle({
      costUsd: reported ?? reserve,
      costEstimated: reported === null,
      actualModel,
    });
    const base64 = Array.isArray(body?.data) ? (body.data[0]?.b64_json ?? null) : null;
    this.logger.log(
      `LLM image answered: stage=${request.stage} model=${actualModel} attempt=${attempt} ` +
        `imageChars=${typeof base64 === 'string' ? base64.length : 'none'}`,
    );
    return {
      kind: 'ok',
      result: {
        callId,
        model: actualModel,
        base64,
        oversize: false,
        costUsd: reported ?? reserve,
      },
    };
  }

  /** Только этап, модель, попытка и класс отказа: ни ключа, ни промпта, ни байтов ответа. */
  private warn(stage: string, model: string, attempt: number, errorClass: string): void {
    this.logger.warn(
      `LLM image call failed: stage=${stage} model=${model} attempt=${attempt} error=${errorClass}`,
    );
  }
}

type LimitedRead =
  | { kind: 'json'; body: ImagesBody | null }
  | { kind: 'oversize' }
  | { kind: 'broken' }
  | { kind: 'aborted' };

/** Тело ответа не длиннее `maxBytes`: дальше чтение обрывается, а не копится в памяти. */
async function readLimitedJson(res: Response, maxBytes: number): Promise<LimitedRead> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'oversize' };
  }
  if (!res.body) return { kind: 'broken' };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'oversize' };
      }
      chunks.push(value);
    }
  } catch (error) {
    return isAbort(error) ? { kind: 'aborted' } : { kind: 'broken' };
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    return { kind: 'json', body: JSON.parse(text) as ImagesBody | null };
  } catch {
    return { kind: 'broken' };
  }
}
