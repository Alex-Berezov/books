import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LlmConfig } from './llm.config';
import { llmModelsUnavailable } from './llm.errors';

/** Цена модели в долларах за токен; `null` - у модели нет фиксированной цены (Р24). */
export interface LlmModelPrice {
  input: Prisma.Decimal | null;
  output: Prisma.Decimal | null;
}

export interface LlmModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  price: LlmModelPrice;
  /** Модель принимает `response_format` JSON-схемой. */
  structuredOutputs: boolean;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
    pricing?: { prompt?: unknown; completion?: unknown };
    supported_parameters?: unknown;
  }>;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const MODELS_TIMEOUT_MS = 15_000;
/** После сбоя - пауза перед новой попыткой: иначе каждый вызов ждёт таймаут похода наружу. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/**
 * Список моделей OpenRouter с ценами. Ручка публичная (ключ не нужен), поэтому список работает
 * и в `DISABLED`. Кэш в памяти на час: цена нужна на каждый резерв, ходить за ней на каждый
 * вызов незачем.
 */
@Injectable()
export class LlmModelsService {
  private readonly logger = new Logger(LlmModelsService.name);
  private cache: { at: number; models: LlmModelInfo[] } | null = null;
  private inflight: Promise<LlmModelInfo[]> | null = null;
  private retryAt = 0;

  constructor(private readonly config: LlmConfig) {}

  async list(): Promise<LlmModelInfo[]> {
    const now = Date.now();
    if (this.cache && (now - this.cache.at < CACHE_TTL_MS || now < this.retryAt)) {
      return this.cache.models;
    }
    // Без списка в памяти минута после сбоя - сразу 503, без нового ожидания таймаута.
    if (!this.cache && now < this.retryAt) throw llmModelsUnavailable();
    // Параллельные запросы при пустом кэше делят один поход наружу.
    this.inflight ??= this.fetchModels().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchModels(): Promise<LlmModelInfo[]> {
    let body: OpenRouterModelsResponse | null = null;
    let failure = '';
    try {
      const res = await fetch(`${this.config.baseUrl()}/models`, {
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (res.ok) {
        const parsed = (await res.json()) as OpenRouterModelsResponse;
        // Ответ 200 без списка - тот же сбой: пустой каталог на час отклонил бы любую модель.
        if (Array.isArray(parsed?.data) && parsed.data.length > 0) body = parsed;
        else failure = 'unexpected response shape';
      } else failure = `HTTP ${res.status}`;
    } catch (error) {
      failure = String(error);
    }
    if (!body) {
      // Устаревший список лучше отказа: факт берётся из `usage.cost`, старая цена влияет только
      // на резерв (решение арбитра `F05 | F05-1`, Р-Е). `cache.at` не трогаем: список остаётся
      // устаревшим, новая попытка - не раньше чем через минуту.
      this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      if (this.cache) {
        this.logger.warn(`OpenRouter model list unavailable, serving a stale one: ${failure}`);
        return this.cache.models;
      }
      this.logger.warn(`OpenRouter model list unavailable: ${failure}`);
      throw llmModelsUnavailable();
    }

    const models = (body.data ?? []).flatMap((raw): LlmModelInfo[] => {
      if (typeof raw.id !== 'string' || !raw.id) return [];
      const free = raw.id.endsWith(':free');
      return [
        {
          id: raw.id,
          name: typeof raw.name === 'string' ? raw.name : raw.id,
          contextLength: typeof raw.context_length === 'number' ? raw.context_length : null,
          price: {
            input: free ? new Prisma.Decimal(0) : parsePrice(raw.pricing?.prompt),
            output: free ? new Prisma.Decimal(0) : parsePrice(raw.pricing?.completion),
          },
          structuredOutputs:
            Array.isArray(raw.supported_parameters) &&
            raw.supported_parameters.includes('structured_outputs'),
        },
      ];
    });
    this.cache = { at: Date.now(), models };
    return models;
  }
}

/**
 * Цена OpenRouter - строка долларов за токен. Отрицательная или нечисловая (динамическая цена
 * роутера, `-1`) - цены нет: такая модель допускается в этап только с `maxPricePerMTok` (Р24).
 */
export function parsePrice(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const price = new Prisma.Decimal(value);
    return price.isFinite() && !price.isNegative() ? price : null;
  } catch {
    return null;
  }
}
