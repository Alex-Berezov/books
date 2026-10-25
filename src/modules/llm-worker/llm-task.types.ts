import { LlmTask } from '@prisma/client';

/**
 * Вид задачи повтора куска (`F05-7v`, обработчик - `translation/retry/chunk-retry.handler.ts`).
 * Держатель ключа пары с этим видом даёт «продолжить» отказ 409 `RETRY_IN_PROGRESS` (решение
 * арбитра `F05 | F05-1w`).
 */
export const TRANSLATION_RETRY_KIND = 'translation_retry';

/** 409: на паре «запуск, язык» идёт повтор куска - «продолжить» запуска и новый повтор ждут его. */
export const RETRY_IN_PROGRESS = 'RETRY_IN_PROGRESS';

/** 409: запуск перевода идёт (или его шаг доделывается) - повтор и правка куска ждут паузы. */
export const RUN_ACTIVE = 'RUN_ACTIVE';

/** Причина отказа задачи, исчерпавшей захваты подряд без завершённого шага. */
export const TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS';

/** Причина отказа шага, бросившего исключение без распознанного кода (Р-Ж). */
export const STEP_ERROR = 'STEP_ERROR';

/**
 * Итог одного шага. `continue` - та же строка снова `pending`: язык идёт строго по шагу за раз
 * (Р1). `wait` - не статус, а `pending` с `runAfter` в будущем: условие перепроверяет сам
 * обработчик при следующем захвате.
 */
export type LlmTaskStepResult =
  | { kind: 'done' }
  | { kind: 'continue'; runAfter?: Date }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string };

export interface LlmTaskContext {
  /** Прерывание при остановке процесса; сигнал своего шага, а не общий на процесс. */
  signal: AbortSignal;
  /**
   * Продление аренды условием по `ownerToken`. Аренда потеряна - бросает
   * `LlmTaskLeaseLostError`, попытка не делается.
   */
  renewLease: () => Promise<void>;
  /**
   * Готовые опции `LlmService.callStage`: `beforeAttempt` (продление аренды перед каждой
   * попыткой), `signal` и `taskId`. Обработчик передаёт их в каждый вызов модели целиком -
   * без них вызов длиннее аренды отдаёт задачу второму исполнителю.
   */
  callOptions: { beforeAttempt: () => Promise<void>; signal: AbortSignal; taskId: string };
}

export interface LlmTaskHandler {
  run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult>;
  /**
   * Задача стала `failed` не по итогу `fail` самого обработчика: исчерпала захваты
   * (`TOO_MANY_ATTEMPTS`) или шаг бросил исключение (код `LlmError`, 503 модуля LLM или
   * `STEP_ERROR`). Что делать с операцией - решает обработчик.
   *
   * Зовётся один раз после успешной условной записи `failed`; исключение пишется в лог,
   * задача остаётся `failed`. Обязан быть идемпотентным.
   */
  onFailed?(task: LlmTask, reason: string): Promise<void>;
}
