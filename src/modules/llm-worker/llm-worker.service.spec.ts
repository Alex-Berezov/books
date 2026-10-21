import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmTask } from '@prisma/client';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { LlmBudgetService } from '../llm/llm-budget.service';
import { LlmConfig } from '../llm/llm.config';
import { LlmBudgetExceededError, LlmError } from '../llm/llm.errors';
import { LlmTaskHandlerRegistry } from './llm-task-handler.registry';
import { LlmTaskService } from './llm-task.service';
import { LlmWorkerConfig } from './llm-worker.config';
import { LlmWorkerService, stepFailureCode } from './llm-worker.service';

describe('LlmWorkerService', () => {
  let env: Record<string, string | undefined>;
  let registry: BackgroundJobsRegistry;
  let handlers: LlmTaskHandlerRegistry;
  let tasks: {
    claim: jest.Mock;
    finish: jest.Mock;
    fail: jest.Mock;
    renewLease: jest.Mock;
    release: jest.Mock;
    cancelOrphanedTasks: jest.Mock;
    countUnknownKinds: jest.Mock;
  };
  let budget: { releaseStaleCalls: jest.Mock };
  let worker: LlmWorkerService;

  const task = { id: 't1', kind: 'k', attempt: 1 } as LlmTask;

  const build = () => {
    const config = { get: (k: string) => env[k] } as unknown as ConfigService;
    worker = new LlmWorkerService(
      tasks as unknown as LlmTaskService,
      handlers,
      budget as unknown as LlmBudgetService,
      new LlmConfig(config),
      new LlmWorkerConfig(config),
      registry,
    );
  };

  const state = () => registry.list().find((j) => j.name === 'llm-worker');
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    env = { OPENROUTER_API_KEY: 'sk-or-test', LLM_CALL_TIMEOUT_MS: '1234' };
    registry = new BackgroundJobsRegistry();
    handlers = new LlmTaskHandlerRegistry();
    tasks = {
      claim: jest.fn().mockResolvedValue(null),
      finish: jest.fn().mockResolvedValue(true),
      fail: jest.fn().mockResolvedValue(true),
      renewLease: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(true),
      cancelOrphanedTasks: jest.fn().mockResolvedValue(0),
      countUnknownKinds: jest.fn().mockResolvedValue(0),
    };
    budget = { releaseStaleCalls: jest.fn().mockResolvedValue(0) };
    handlers.register('k', { run: () => Promise.resolve({ kind: 'done' }) });
    build();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await worker.onModuleDestroy();
  });

  describe('timer and registry state', () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }));

    it('with the kill switch at 0 is DISABLED with the reason, starts no timer and claims nothing', async () => {
      env.TRANSLATION_WORKER_ENABLED = '0';
      build();
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(state()).toMatchObject({ state: 'DISABLED', reason: 'TRANSLATION_WORKER_ENABLED=0' });
      expect(jest.getTimerCount()).toBe(0);
      expect(tasks.claim).not.toHaveBeenCalled();
      expect(budget.releaseStaleCalls).not.toHaveBeenCalled();
    });

    it('without an OpenRouter key is DISABLED with the reason and claims nothing', async () => {
      env.OPENROUTER_API_KEY = '';
      build();
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(120_000);

      expect(state()?.state).toBe('DISABLED');
      expect(state()?.reason).toContain('OPENROUTER_API_KEY');
      expect(tasks.claim).not.toHaveBeenCalled();
    });

    it('when ACTIVE polls on its interval and cleans up once a minute with the call timeout', async () => {
      env.TRANSLATION_WORKER_POLL_MS = '1500';
      env.TRANSLATION_WORKER_CONCURRENCY = '3';
      build();
      worker.onApplicationBootstrap();
      expect(state()).toMatchObject({
        state: 'ACTIVE',
        schedule: 'polls every 1500 ms, 3 slot(s)',
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(tasks.claim).toHaveBeenCalledTimes(1);
      expect(budget.releaseStaleCalls).toHaveBeenCalledTimes(1);
      expect(budget.releaseStaleCalls).toHaveBeenCalledWith(1234);
      expect(tasks.cancelOrphanedTasks).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1500);
      expect(tasks.claim).toHaveBeenCalledTimes(2);
      expect(budget.releaseStaleCalls).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(budget.releaseStaleCalls).toHaveBeenCalledTimes(2);
    });

    it('a cleanup that hangs does not hold claiming back', async () => {
      budget.releaseStaleCalls.mockReturnValue(new Promise(() => undefined));
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(tasks.claim).toHaveBeenCalledTimes(1);
    });

    it('a cleanup still running is not started again a minute later', async () => {
      budget.releaseStaleCalls.mockReturnValue(new Promise(() => undefined));
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(budget.releaseStaleCalls).toHaveBeenCalledTimes(1);
      expect(tasks.claim.mock.calls.length).toBeGreaterThan(1);
    });

    it('starts on application bootstrap, after every module registered its handlers', () => {
      // Не в `onModuleInit`: модули конвейера регистрируют обработчики там же и позже.
      expect('onModuleInit' in worker).toBe(false);
      expect(typeof worker.onApplicationBootstrap).toBe('function');
    });

    it('shutdown waits for a claim in progress and hands its task back before returning', async () => {
      let resolveClaim: (t: LlmTask) => void = () => undefined;
      tasks.claim.mockReturnValueOnce(new Promise<LlmTask>((resolve) => (resolveClaim = resolve)));
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(tasks.claim).toHaveBeenCalledTimes(1);

      let destroyed = false;
      const destroying = worker.onModuleDestroy().then(() => (destroyed = true));
      await flush();
      expect(destroyed).toBe(false);
      resolveClaim(task);
      await destroying;

      expect(tasks.release).toHaveBeenCalledTimes(1);
      expect(tasks.release).toHaveBeenCalledWith(task, expect.any(String));
    });

    it('a failing cleanup does not stop claiming in the same pass', async () => {
      budget.releaseStaleCalls.mockRejectedValue(new Error('db down'));
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(tasks.claim).toHaveBeenCalledTimes(1);
    });
  });

  it('never fills more slots than configured', async () => {
    env.TRANSLATION_WORKER_CONCURRENCY = '2';
    handlers = new LlmTaskHandlerRegistry();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handlers.register('k', { run: () => gate.then(() => ({ kind: 'done' as const })) });
    build();
    tasks.claim.mockResolvedValue(task);

    const pass = worker.runOnce();
    await flush();
    expect(tasks.claim).toHaveBeenCalledTimes(2);
    release();
    await pass;
  });

  it('on shutdown aborts the step in flight and hands the task back, whatever the step throws', async () => {
    handlers = new LlmTaskHandlerRegistry();
    let seen: AbortSignal | undefined;
    handlers.register('k', {
      run: (_task, ctx) =>
        new Promise((_resolve, reject) => {
          seen = ctx.signal;
          // Не `LLM_ABORTED`: обёртка обработчика или закрытое соединение базы.
          ctx.signal.addEventListener('abort', () => reject(new TypeError('connection closed')));
        }),
    });
    build();
    const slot = worker.runTask(task, 'owner');

    await worker.onModuleDestroy();
    await slot;

    expect(seen?.aborted).toBe(true);
    expect(tasks.finish).not.toHaveBeenCalled();
    expect(tasks.fail).not.toHaveBeenCalled();
    expect(tasks.release).toHaveBeenCalledTimes(1);
    expect(tasks.release).toHaveBeenCalledWith(task, 'owner');
  });

  it('a handler that catches the shutdown abort and returns fail: the task is handed back, not failed', async () => {
    handlers = new LlmTaskHandlerRegistry();
    handlers.register('k', {
      run: (_task, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () =>
            resolve({ kind: 'fail', reason: 'LLM_ABORTED' }),
          );
        }),
    });
    build();
    const slot = worker.runTask(task, 'owner');

    await worker.onModuleDestroy();
    await slot;

    expect(tasks.finish).not.toHaveBeenCalled();
    expect(tasks.release).toHaveBeenCalledTimes(1);
    expect(tasks.release).toHaveBeenCalledWith(task, 'owner');
  });

  it('a real fail of the handler stays a fail', async () => {
    handlers = new LlmTaskHandlerRegistry();
    handlers.register('k', {
      run: () => Promise.resolve({ kind: 'fail', reason: 'SOURCE_MISSING' }),
    });
    build();

    await worker.runTask(task, 'owner');

    expect(tasks.finish).toHaveBeenCalledTimes(1);
    expect(tasks.finish).toHaveBeenCalledWith(task, 'owner', {
      kind: 'fail',
      reason: 'SOURCE_MISSING',
    });
    expect(tasks.release).not.toHaveBeenCalled();
  });

  it('a task claimed while shutting down is handed back without running its step', async () => {
    handlers = new LlmTaskHandlerRegistry();
    const run = jest.fn();
    handlers.register('k', { run });
    build();
    tasks.claim.mockImplementation(async () => {
      await worker.onModuleDestroy();
      return task;
    });

    await worker.runOnce();

    expect(run).not.toHaveBeenCalled();
    expect(tasks.release).toHaveBeenCalledTimes(1);
    expect(tasks.claim).toHaveBeenCalledTimes(1);
  });

  it('gives the step ready call options: lease renewal, its own signal and the task id', async () => {
    handlers = new LlmTaskHandlerRegistry();
    const signals: AbortSignal[] = [];
    handlers.register('k', {
      run: async (_task, ctx) => {
        expect(ctx.callOptions.taskId).toBe('t1');
        expect(ctx.callOptions.signal).toBe(ctx.signal);
        await ctx.callOptions.beforeAttempt();
        signals.push(ctx.signal);
        return { kind: 'done' };
      },
    });
    build();

    await worker.runTask(task, 'owner');
    await worker.runTask(task, 'owner');

    expect(tasks.renewLease).toHaveBeenCalledTimes(2);
    expect(tasks.renewLease).toHaveBeenCalledWith('t1', 'owner');
    // Свой сигнал на каждый шаг, а не один общий на процесс.
    expect(signals[0]).not.toBe(signals[1]);
    await worker.onModuleDestroy();
    expect(signals.every((s) => !s.aborted)).toBe(true);
  });

  it('an operation stopped mid-step ends the step like continue, not as a failure (Р19)', async () => {
    handlers = new LlmTaskHandlerRegistry();
    const onFailed = jest.fn();
    handlers.register('k', {
      run: () => Promise.reject(new LlmError('LLM_OPERATION_NOT_ACTIVE', 'paused')),
      onFailed,
    });
    build();

    await worker.runTask(task, 'owner');

    expect(tasks.finish).toHaveBeenCalledTimes(1);
    expect(tasks.finish).toHaveBeenCalledWith(task, 'owner', { kind: 'continue' });
    expect(tasks.fail).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('a failing write of the result does not escape the slot', async () => {
    tasks.finish.mockRejectedValue(new Error('db down'));
    await expect(worker.runTask(task, 'owner')).resolves.toBeUndefined();
  });

  it('a throwing onFailed hook is called once, logged and does not escape the slot', async () => {
    handlers = new LlmTaskHandlerRegistry();
    const onFailed = jest.fn(() => Promise.reject(new Error('hook')));
    handlers.register('k', { run: () => Promise.reject(new Error('boom')), onFailed });
    build();

    await expect(worker.runTask(task, 'owner')).resolves.toBeUndefined();

    expect(tasks.fail).toHaveBeenCalledTimes(1);
    expect(tasks.fail).toHaveBeenCalledWith(task, 'owner', 'STEP_ERROR');
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('onFailed is not called when the failure could not be written (task is no longer ours)', async () => {
    handlers = new LlmTaskHandlerRegistry();
    const onFailed = jest.fn();
    handlers.register('k', { run: () => Promise.reject(new Error('boom')), onFailed });
    build();
    tasks.fail.mockResolvedValue(false);

    await worker.runTask(task, 'owner');

    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe('stepFailureCode (Р-Ж)', () => {
  it('takes the code of an LlmError', () => {
    expect(stepFailureCode(new LlmError('LLM_UNAVAILABLE', 'x'))).toBe('LLM_UNAVAILABLE');
  });

  it('takes the code from the body of a 503 of the LLM module', () => {
    expect(
      stepFailureCode(new ServiceUnavailableException({ statusCode: 503, code: 'LLM_DISABLED' })),
    ).toBe('LLM_DISABLED');
  });

  it('does not take a code from another HTTP status', () => {
    expect(stepFailureCode(new ConflictException({ statusCode: 409, code: 'SOMETHING' }))).toBe(
      'STEP_ERROR',
    );
  });

  it('keeps the budget level: an operation limit and the ceiling are different pauses', () => {
    expect(stepFailureCode(new LlmBudgetExceededError('operation'))).toBe(
      'LLM_BUDGET_EXCEEDED:operation',
    );
    expect(stepFailureCode(new LlmBudgetExceededError('ceiling'))).toBe(
      'LLM_BUDGET_EXCEEDED:ceiling',
    );
  });

  it('anything else is STEP_ERROR', () => {
    expect(stepFailureCode(new TypeError('boom'))).toBe('STEP_ERROR');
    expect(stepFailureCode('string')).toBe('STEP_ERROR');
  });
});

describe('LlmWorkerConfig', () => {
  const configOf = (env: Record<string, string>) =>
    new LlmWorkerConfig({ get: (k: string) => env[k] } as unknown as ConfigService);

  it('falls back to the defaults on missing or invalid values', () => {
    const config = configOf({
      TRANSLATION_WORKER_CONCURRENCY: 'abc',
      TRANSLATION_WORKER_POLL_MS: '-5',
      TRANSLATION_WORKER_WAIT_MS: '1.5',
    });
    expect(config.enabled()).toBe(true);
    expect(config.concurrency()).toBe(2);
    expect(config.pollMs()).toBe(2000);
    expect(config.waitMs()).toBe(10_000);
    expect(config.maxAttempts()).toBe(5);
  });

  it('reads valid values and the kill switch', () => {
    const config = configOf({
      TRANSLATION_WORKER_ENABLED: ' 0 ',
      TRANSLATION_WORKER_CONCURRENCY: '4',
      TRANSLATION_TASK_MAX_ATTEMPTS: '7',
    });
    expect(config.enabled()).toBe(false);
    expect(config.concurrency()).toBe(4);
    expect(config.maxAttempts()).toBe(7);
  });
});
