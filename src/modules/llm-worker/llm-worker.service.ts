import {
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { LlmTask } from '@prisma/client';
import { randomUUID } from 'crypto';
import { closeWithin } from '../../shared/shutdown/graceful-close';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { LlmBudgetService } from '../llm/llm-budget.service';
import { LlmConfig } from '../llm/llm.config';
import { LlmBudgetExceededError, LlmError } from '../llm/llm.errors';
import { LlmTaskHandlerRegistry } from './llm-task-handler.registry';
import { LlmTaskService } from './llm-task.service';
import { LlmTaskContext, LlmTaskStepResult, STEP_ERROR, TOO_MANY_ATTEMPTS } from './llm-task.types';
import { LlmTaskLeaseLostError } from './llm-worker.errors';
import { LlmWorkerConfig } from './llm-worker.config';

/** Чистка зависших вызовов и счёт задач без обработчика - не чаще раза в минуту. */
const HOUSEKEEPING_EVERY_MS = 60_000;

/**
 * Код отказа модуля LLM: `LlmError.code` или `code` в теле 503 (`LLM_DISABLED`,
 * `LLM_MODELS_UNAVAILABLE`); нераспознанное исключение - `STEP_ERROR` (решение арбитра
 * `F05 | F05-1`, Р-Ж). Отказ шага, а не успех и не бесконечный повтор.
 */
export function stepFailureCode(error: unknown): string {
  // Уровень потолка нужен обработчику: `LIMIT_REACHED` и `CEILING_REACHED` - разные паузы.
  if (error instanceof LlmBudgetExceededError) return `${error.code}:${error.level}`;
  if (error instanceof LlmError) return error.code;
  if (error instanceof HttpException && error.getStatus() === 503) {
    const body = error.getResponse();
    const code =
      typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
    if (typeof code === 'string' && code) return code;
  }
  return STEP_ERROR;
}

/**
 * Фоновый исполнитель LLM на Postgres (`F05-1w`, Р1, ADR-021): таймер `setTimeout(...).unref()`,
 * слоты `TRANSLATION_WORKER_CONCURRENCY`, опрос `TRANSLATION_WORKER_POLL_MS`. Redis не нужен.
 *
 * Задачу ставят модули конвейера, а не исполнитель: ни сидов, ни крона, ни задач при старте
 * (Р25). Без ключа OpenRouter или с `TRANSLATION_WORKER_ENABLED=0` таймер не заводится,
 * и реестр фона показывает `DISABLED` с причиной - регистрация стоит в той же ветке, что
 * решает.
 *
 * ⚠️ Прерывание вызовов в полёте - на `onModuleDestroy`, то есть на `app.close()`. Хуков
 * выключения (`enableShutdownHooks`) в приложении нет, поэтому на проде по SIGTERM вызов
 * не прерывается: его факт пишет чистка (факт = резерв, Р21), аренда истекает сама (решение
 * арбитра `F05 | F05-1w`).
 */
@Injectable()
export class LlmWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LlmWorkerService.name);
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  /** Проходы таймера (захват, чистка): выключение ждёт и их, а не только слоты. */
  private readonly passes = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private claiming = false;
  private lastHousekeeping = 0;
  private housekeepingRunning = false;

  private static readonly NAME = 'llm-worker';
  private static readonly PURPOSE =
    'Runs LLM pipeline tasks (translation steps) from Postgres with leases and slots';

  constructor(
    private readonly tasks: LlmTaskService,
    private readonly handlers: LlmTaskHandlerRegistry,
    private readonly budget: LlmBudgetService,
    private readonly llmConfig: LlmConfig,
    private readonly config: LlmWorkerConfig,
    private readonly backgroundJobs: BackgroundJobsRegistry,
  ) {}

  // Не `onModuleInit`: модули конвейера регистрируют обработчики в своём `onModuleInit` и
  // поднимаются после этого модуля - первый проход до них видел бы пустой реестр.
  onApplicationBootstrap(): void {
    if (!this.config.enabled()) {
      this.register('DISABLED', 'TRANSLATION_WORKER_ENABLED=0');
      return;
    }
    if (!this.llmConfig.enabled()) {
      this.register('DISABLED', 'OPENROUTER_API_KEY is not configured — LLM calls are disabled');
      return;
    }
    this.scheduleNext(0);
    this.register('ACTIVE');
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Вызовы в полёте прерываются; аренда их задач истекает сама, следующий захват их доделает.
    this.abort.abort();
    await closeWithin(this.logger, 'llm-worker slots', () =>
      Promise.allSettled([...this.passes, ...this.inFlight]),
    );
  }

  /**
   * Один проход: свободные слоты заполняются захваченными задачами. Возвращает, когда все
   * запущенные в этом проходе шаги закончились (для таймера проход не ждёт - см. `tick`).
   */
  async runOnce(): Promise<void> {
    // Два прохода подряд не захватывают параллельно: иначе слотов стало бы больше заданного.
    if (this.claiming) return;
    this.claiming = true;
    const started: Promise<void>[] = [];
    try {
      while (!this.stopped && this.inFlight.size < this.config.concurrency()) {
        const ownerToken = randomUUID();
        const task = await this.tasks.claim(this.handlers.kinds(), ownerToken);
        if (!task) break;
        if (this.stopped) {
          // Остановка пришла, пока шёл захват: шаг не начинается, задача возвращается сразу,
          // а не ждёт истечения аренды.
          await this.tasks.release(task, ownerToken);
          break;
        }
        // `runTask` сам не бросает; `catch` здесь - на случай, если проход оборвётся раньше
        // `Promise.all` и слот останется без обработчика.
        const slot = this.runTask(task, ownerToken)
          .catch((error: unknown) => this.logTickError(error))
          .finally(() => this.inFlight.delete(slot));
        this.inFlight.add(slot);
        started.push(slot);
      }
    } finally {
      this.claiming = false;
    }
    await Promise.all(started);
  }

  /** Чистка зависших вызовов (Р21) методом бюджета и предупреждение о задачах без обработчика. */
  async housekeeping(): Promise<void> {
    const orphaned = await this.tasks.cancelOrphanedTasks();
    if (orphaned > 0) {
      this.logger.warn(`Cancelled ${orphaned} orphaned LLM task(s) of stopped operations`);
    }
    const released = await this.budget.releaseStaleCalls(this.llmConfig.callTimeoutMs());
    if (released > 0) {
      this.logger.warn(`Released ${released} stale LLM call(s) at fact = reserve`);
    }
    const unknown = await this.tasks.countUnknownKinds(this.handlers.kinds());
    if (unknown > 0) {
      this.logger.warn(`${unknown} pending LLM task(s) have no registered handler and wait`);
    }
  }

  /** Шаг одной захваченной задачи. Исключение отсюда не уходит: слот не роняет таймер. */
  async runTask(task: LlmTask, ownerToken: string): Promise<void> {
    try {
      await this.step(task, ownerToken);
    } catch (error) {
      // Сбой записи итога (база): задача остаётся `running`, аренда истечёт, захват повторит.
      this.logTickError(error);
    }
  }

  private async step(task: LlmTask, ownerToken: string): Promise<void> {
    if (task.attempt > this.config.maxAttempts()) {
      await this.failAndNotify(task, ownerToken, TOO_MANY_ATTEMPTS);
      return;
    }
    const handler = this.handlers.get(task.kind);
    if (!handler) return; // реестр не меняется после старта; аренда истечёт сама
    // Свой сигнал на шаг: `AbortSignal.any` в клиенте вешает зависимые сигналы на источник,
    // и общий на процесс сигнал копил бы их тысячами за время жизни процесса.
    const stepAbort = new AbortController();
    const onStop = () => stepAbort.abort();
    this.abort.signal.addEventListener('abort', onStop, { once: true });
    const renewLease = () => this.tasks.renewLease(task.id, ownerToken);
    const ctx: LlmTaskContext = {
      signal: stepAbort.signal,
      renewLease,
      callOptions: { beforeAttempt: renewLease, signal: stepAbort.signal, taskId: task.id },
    };
    let result: LlmTaskStepResult;
    try {
      result = await handler.run(task, ctx);
    } catch (error) {
      this.abort.signal.removeEventListener('abort', onStop);
      if (error instanceof LlmTaskLeaseLostError) return; // задача у другого владельца
      if (this.abort.signal.aborted) {
        // Остановка процесса: что бы ни бросил шаг после прерывания, это не отказ. Задача
        // возвращается без засчитанного захвата; не успели (база закрывается) - её заберёт
        // захват по истечении аренды.
        await this.tasks.release(task, ownerToken);
        return;
      }
      if (error instanceof LlmError && error.code === 'LLM_OPERATION_NOT_ACTIVE') {
        // Операцию остановили посреди шага (пауза, отмена): шаг кончается так же, как
        // `continue` - `cancelled` при операции не `active`, а не отказом (Р19).
        await this.tasks.finish(task, ownerToken, { kind: 'continue' });
        return;
      }
      const code = stepFailureCode(error);
      if (code === STEP_ERROR) {
        // Только имя: текст исключения может нести текст книги.
        this.logger.error(
          `LLM task ${task.id} (${task.kind}) step threw ${error instanceof Error ? error.name : typeof error}`,
        );
      }
      await this.failAndNotify(task, ownerToken, code);
      return;
    }
    this.abort.signal.removeEventListener('abort', onStop);
    if (result.kind === 'fail' && this.abort.signal.aborted) {
      // Обработчик поймал прерывание остановки и вернул отказ: это не отказ шага.
      await this.tasks.release(task, ownerToken);
      return;
    }
    await this.tasks.finish(task, ownerToken, result);
  }

  private async failAndNotify(task: LlmTask, ownerToken: string, reason: string): Promise<void> {
    if (!(await this.tasks.fail(task, ownerToken, reason))) return;
    try {
      await this.handlers.get(task.kind)?.onFailed?.(task, reason);
    } catch (error) {
      this.logger.error(
        `LLM task ${task.id} onFailed(${reason}) threw ${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }

  private scheduleNext(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext(this.config.pollMs()));
    }, delay);
    // Таймер не держит процесс: тесты и выключение от этого зависят.
    this.timer.unref?.();
  }

  private tick(): Promise<void> {
    if (!this.housekeepingRunning && Date.now() - this.lastHousekeeping >= HOUSEKEEPING_EVERY_MS) {
      this.lastHousekeeping = Date.now();
      // Чистка идёт рядом с захватом, а не перед ним: ни её сбой, ни её длина захват не держат.
      // Новая не начинается, пока идёт прежняя: две чистки дрались бы за одни строки.
      this.housekeepingRunning = true;
      this.track(this.housekeeping().finally(() => (this.housekeepingRunning = false)));
    }
    // Шаги идут в слотах и таймер не ждут: следующий опрос добирает освободившиеся слоты.
    this.track(this.runOnce());
    return Promise.resolve();
  }

  private track(pass: Promise<void>): void {
    const tracked = pass
      .catch((error: unknown) => this.logTickError(error))
      .finally(() => this.passes.delete(tracked));
    this.passes.add(tracked);
  }

  private logTickError(error: unknown): void {
    this.logger.error(
      `LLM worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private register(state: 'ACTIVE' | 'DISABLED', reason?: string): void {
    this.backgroundJobs.register({
      name: LlmWorkerService.NAME,
      state,
      ...(reason ? { reason } : {}),
      ...(state === 'ACTIVE'
        ? {
            schedule: `polls every ${this.config.pollMs()} ms, ${this.config.concurrency()} slot(s)`,
          }
        : {}),
      purpose: LlmWorkerService.PURPOSE,
    });
  }
}
