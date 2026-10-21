import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Отказы модуля LLM, которые ловит вызывающий код (исполнитель `F05-1w`, этапы конвейера).
 * Наружу по HTTP они не уходят: ни одна ручка этой пачки модель не зовёт (Р25).
 *
 * Код отказа - устойчивое имя: по нему исполнитель ставит операции `pauseReason`.
 * Два отказа приходят не `LlmError`, а `HttpException` 503 с `code` в теле - `LLM_DISABLED`
 * и `LLM_MODELS_UNAVAILABLE` (фабрики ниже): это HTTP-форма будущих ручек. Исполнитель
 * разбирает оба вида (решение арбитра `F05 | F05-1`, Р-Ж); новых `HttpException` в клиенте
 * и `callStage` не заводить.
 */
export type LlmErrorCode =
  | 'LLM_BUDGET_EXCEEDED'
  | 'LLM_NO_COMPLIANT_PROVIDER'
  | 'LLM_INSUFFICIENT_FUNDS'
  | 'LLM_INVALID_RESPONSE'
  | 'LLM_PROVIDER_ERROR'
  | 'LLM_UNAVAILABLE'
  | 'LLM_OPERATION_NOT_ACTIVE'
  | 'LLM_STAGE_DISABLED'
  | 'LLM_UNKNOWN_STAGE'
  | 'LLM_NO_PRICE';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Уровень, на котором не хватило денег: общий потолок проверяется раньше лимита операции (Р4). */
export type BudgetLevel = 'ceiling' | 'operation';

export class LlmBudgetExceededError extends LlmError {
  constructor(readonly level: BudgetLevel) {
    super(
      'LLM_BUDGET_EXCEEDED',
      level === 'ceiling'
        ? 'LLM spending ceiling would be exceeded'
        : 'LLM operation limit would be exceeded',
    );
  }
}

/**
 * Ключа нет (не задан или пустая строка): приложение живёт, но всё, что зовёт модель, отвечает
 * 503 с кодом в теле. Объект в теле, а не строка - иначе кода не видно (образец -
 * `audio-chapter.service.ts`, `conflict`).
 */
export function llmDisabled(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    message: 'LLM is disabled: OPENROUTER_API_KEY is not configured on this server',
    code: 'LLM_DISABLED',
  });
}

/** Список моделей OpenRouter недоступен, а устаревшего в памяти нет (Р-Е). */
export function llmModelsUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    message: 'OpenRouter model list is unavailable',
    code: 'LLM_MODELS_UNAVAILABLE',
  });
}
