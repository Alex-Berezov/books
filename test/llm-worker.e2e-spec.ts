import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { LlmTask, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID, LlmBudgetService } from '../src/modules/llm/llm-budget.service';
import { LlmError } from '../src/modules/llm/llm.errors';
import { OpenRouterClient } from '../src/modules/llm/openrouter.client';
import { LlmTaskHandlerRegistry } from '../src/modules/llm-worker/llm-task-handler.registry';
import { LlmTaskService, pairKeyOf } from '../src/modules/llm-worker/llm-task.service';
import {
  LlmTaskContext,
  LlmTaskStepResult,
  TRANSLATION_RETRY_KIND,
} from '../src/modules/llm-worker/llm-task.types';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { utcTimestamp } from '../src/shared/prisma/utc-timestamp';

/**
 * F05-1w: фоновый исполнитель на Postgres. Захват, аренда, токен владельца и переходы операции
 * проверяются на настоящей базе: гонки двух захватов и условие по токену на моках не видны.
 * Таймер исполнителя в e2e не заведён (ключа нет - `DISABLED`, Р25), проходы зовутся руками.
 * Время аренды - время JS, поэтому подделывается только `Date`, а не таймеры пула `pg`.
 */
describe('LLM worker (e2e)', () => {
  const KIND = 'e2e_worker_kind';
  const FAKE_KEY = 'sk-or-e2e-fake-key';

  let app: INestApplication;
  let prisma: PrismaService;
  let tasks: LlmTaskService;
  let worker: LlmWorkerService;
  let budget: LlmBudgetService;
  let client: OpenRouterClient;

  let step: (task: LlmTask, ctx: LlmTaskContext) => Promise<LlmTaskStepResult>;
  const onFailed = jest.fn<Promise<void>, [LlmTask, string]>(() => Promise.resolve());

  const fakeDateOnly = () =>
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
  const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);

  const operation = (status: 'active' | 'paused' = 'active') =>
    prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: new Prisma.Decimal(10), status },
    });

  const enqueue = (operationId: string, over: { kind?: string; pairKey?: string | null } = {}) =>
    tasks.enqueue({ kind: over.kind ?? KIND, operationId, pairKey: over.pairKey ?? null });

  const taskOf = (id: string) => prisma.llmTask.findUniqueOrThrow({ where: { id } });

  const created = async (operationId: string, pairKey: string | null = null) => {
    const result = await enqueue(operationId, { pairKey });
    if (!result.created) throw new Error('expected a new task');
    return result.task;
  };

  beforeAll(async () => {
    process.env.OPENROUTER_API_KEY = '';
    process.env.TRANSLATION_WORKER_POLL_MS = '50';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    tasks = app.get(LlmTaskService);
    worker = app.get(LlmWorkerService);
    budget = app.get(LlmBudgetService);
    client = app.get(OpenRouterClient, { strict: false });
    app.get(LlmTaskHandlerRegistry).register(KIND, {
      run: (task, ctx) => step(task, ctx),
      onFailed: (task, reason) => onFailed(task, reason),
    });
  });

  beforeEach(() => {
    step = () => Promise.resolve({ kind: 'done' });
    onFailed.mockClear();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = '';
    // Хвосты теста не должны достаться захвату следующего.
    await prisma.llmTask.updateMany({
      where: { status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled' },
    });
  });

  afterAll(async () => {
    await prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0 },
    });
    delete process.env.TRANSLATION_WORKER_POLL_MS;
    await app.close();
  });

  describe('claim and lease', () => {
    it('two workers racing for one task: exactly one claims it', async () => {
      const op = await operation();
      const ids = await Promise.all(Array.from({ length: 5 }, () => created(op.id)));

      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) => tasks.claim([KIND], `owner-${i}`)),
      );
      const won = claims.filter((t): t is LlmTask => t !== null).map((t) => t.id);

      // Ни одна задача не досталась двоим. Сколько захватов выиграли - зависит от того, чей
      // кандидат успел уйти конкуренту (`SKIP LOCKED`): проигравший вернёт `null` и опросит снова.
      expect(new Set(won).size).toBe(won.length);
      expect(won.length).toBeGreaterThan(0);
      const rows = await prisma.llmTask.findMany({ where: { operationId: op.id } });
      const running = rows.filter((r) => r.status === 'running');
      expect(running.map((r) => r.id).sort()).toEqual([...won].sort());
      expect(running.every((r) => r.attempt === 1)).toBe(true);
      expect(new Set(running.map((r) => r.ownerToken)).size).toBe(running.length);
      expect(ids).toHaveLength(5);
    });

    it('an expired lease goes to the second worker, and the first one can no longer write', async () => {
      fakeDateOnly();
      const op = await operation();
      const task = await created(op.id);

      const first = await tasks.claim([KIND], 'first');
      expect(first?.id).toBe(task.id);
      expect(await tasks.claim([KIND], 'second')).toBeNull();

      advance(tasks.leaseMs() + 1);
      const second = await tasks.claim([KIND], 'second');
      expect(second?.id).toBe(task.id);

      expect(await tasks.finish(first as LlmTask, 'first', { kind: 'done' })).toBe(false);
      await expect(tasks.renewLease(task.id, 'first')).rejects.toThrow(/lease lost/);
      const row = await taskOf(task.id);
      expect(row).toMatchObject({ status: 'running', ownerToken: 'second', attempt: 2 });
    });

    it('a three-attempt call longer than two timeouts keeps the task: the lease is renewed before each attempt', async () => {
      fakeDateOnly();
      process.env.OPENROUTER_API_KEY = FAKE_KEY;
      const op = await operation();
      const task = await created(op.id);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;
      const timeout = tasks.leaseMs() / 2;
      const competitor: Array<LlmTask | null> = [];
      let n = 0;

      jest.spyOn(client as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      jest.spyOn(global, 'fetch').mockImplementation(async () => {
        // Каждая попытка «длится» почти таймаут: за три попытки проходит больше двух таймаутов.
        advance(timeout - 1);
        competitor.push(await tasks.claim([KIND], `competitor-${n}`));
        n += 1;
        if (n < 3) return new Response('{}', { status: 500 });
        return new Response(
          JSON.stringify({
            model: 'a/priced',
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      await client.chat({
        operationId: op.id,
        stage: 'e2e_worker_stage',
        models: [
          {
            id: 'a/priced',
            inputPrice: new Prisma.Decimal('0.000001'),
            outputPrice: new Prisma.Decimal('0.000001'),
            structuredOutputs: false,
          },
        ],
        messages: [{ role: 'user', content: 'x' }],
        temperature: null,
        maxTokens: 10,
        beforeAttempt: () => tasks.renewLease(task.id, 'owner'),
        taskId: task.id,
      });

      expect(n).toBe(3);
      expect(competitor).toEqual([null, null, null]);
      expect(await tasks.finish(claimed, 'owner', { kind: 'done' })).toBe(true);
      // Каждая попытка записана со ссылкой на задачу.
      expect(await prisma.llmCall.count({ where: { taskId: task.id } })).toBe(3);
    });

    it('a sixth claim in a row after lost leases fails the task with TOO_MANY_ATTEMPTS and tells the handler once', async () => {
      fakeDateOnly();
      const op = await operation();
      const task = await created(op.id);
      const run = jest.fn(() => Promise.resolve<LlmTaskStepResult>({ kind: 'done' }));
      step = run;

      for (let i = 0; i < 5; i++) {
        expect((await tasks.claim([KIND], `lost-${i}`))?.id).toBe(task.id);
        advance(tasks.leaseMs() + 1);
      }
      await worker.runOnce();

      expect(run).not.toHaveBeenCalled();
      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(onFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: task.id }),
        'TOO_MANY_ATTEMPTS',
      );
      expect(await taskOf(task.id)).toMatchObject({
        status: 'failed',
        lastError: 'TOO_MANY_ATTEMPTS',
      });
    });

    it('the fifth claim in a row still runs the step: the limit is "more than five"', async () => {
      fakeDateOnly();
      const op = await operation();
      const task = await created(op.id);
      const run = jest.fn(() => Promise.resolve<LlmTaskStepResult>({ kind: 'done' }));
      step = run;

      for (let i = 0; i < 4; i++) {
        await tasks.claim([KIND], `lost-${i}`);
        advance(tasks.leaseMs() + 1);
      }
      await worker.runOnce();

      expect(run).toHaveBeenCalledTimes(1);
      expect((await taskOf(task.id)).status).toBe('done');
    });

    it('forty steps through continue do not hit the attempt limit', async () => {
      const op = await operation();
      const task = await created(op.id, pairKeyOf(op.id, 'ru'));
      let steps = 0;
      step = () => {
        steps += 1;
        return Promise.resolve(steps < 40 ? { kind: 'continue' } : { kind: 'done' });
      };

      for (let i = 0; i < 40; i++) await worker.runOnce();

      expect(steps).toBe(40);
      expect(onFailed).not.toHaveBeenCalled();
      expect(await taskOf(task.id)).toMatchObject({ status: 'done', attempt: 0 });
      // `continue` - та же строка: на пару одна задача за всё время.
      expect(await prisma.llmTask.count({ where: { operationId: op.id } })).toBe(1);
    });

    it('no registered kinds: nothing is claimed and no query is broken', async () => {
      const op = await operation();
      const task = await created(op.id);
      expect(await tasks.claim([], 'owner')).toBeNull();
      expect((await taskOf(task.id)).status).toBe('pending');
      expect(await tasks.countUnknownKinds([])).toBeGreaterThan(0);
    });

    it('wait re-checks its condition on the next claim and passes once it holds', async () => {
      fakeDateOnly();
      const op = await operation();
      const task = await created(op.id);
      let ready = false;
      const run = jest.fn(() =>
        Promise.resolve<LlmTaskStepResult>(
          ready ? { kind: 'done' } : { kind: 'wait', reason: 'dossier' },
        ),
      );
      step = run;

      await worker.runOnce();
      // Причина ожидания видна в строке задачи.
      expect(await taskOf(task.id)).toMatchObject({
        status: 'pending',
        attempt: 0,
        lastError: 'dossier',
      });
      expect(await tasks.claim([KIND], 'too-early')).toBeNull();

      ready = true;
      advance(10_001);
      await worker.runOnce();

      expect(run).toHaveBeenCalledTimes(2);
      expect((await taskOf(task.id)).status).toBe('done');
    });

    it('a task of a kind without a handler stays pending and untouched', async () => {
      const op = await operation();
      const result = await enqueue(op.id, { kind: 'e2e_unknown_kind' });

      await worker.runOnce();

      const row = await taskOf(result.created ? result.task.id : result.holder.id);
      expect(row).toMatchObject({ status: 'pending', attempt: 0, ownerToken: null });
      expect(
        await tasks.countUnknownKinds(app.get(LlmTaskHandlerRegistry).kinds()),
      ).toBeGreaterThan(0);
    });
  });

  describe('one unfinished task per pair (Р1)', () => {
    it('a second unfinished task on the same pair is not created', async () => {
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'fr');
      const first = await created(op.id, pairKey);
      await tasks.claim([KIND], 'owner');

      const second = await enqueue(op.id, { pairKey });

      expect(second).toMatchObject({ created: false, holder: { id: first.id, status: 'running' } });
      expect(await prisma.llmTask.count({ where: { pairKey } })).toBe(1);
    });

    it('once the pair task is finished, the pair takes a new one', async () => {
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'es');
      await created(op.id, pairKey);
      await worker.runOnce();

      expect((await enqueue(op.id, { pairKey })).created).toBe(true);
    });
  });

  describe('pause, cancel, resume (Р19)', () => {
    it('a task of a paused operation is not claimed', async () => {
      const op = await operation('paused');
      await created(op.id);
      expect(await tasks.claim([KIND], 'owner')).toBeNull();
    });

    it('pause cancels pending tasks in the same transaction', async () => {
      const op = await operation();
      const task = await created(op.id);

      expect(await tasks.pauseOperation(op.id, 'LIMIT_REACHED')).toBe(true);

      expect((await taskOf(task.id)).status).toBe('cancelled');
      expect(await prisma.llmOperation.findUnique({ where: { id: op.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      });
    });

    it('cancel cancels pending tasks too', async () => {
      const op = await operation();
      const task = await created(op.id);
      expect(await tasks.cancelOperation(op.id)).toBe(true);
      expect((await taskOf(task.id)).status).toBe('cancelled');
    });

    it('a running step finishes as cancelled when its operation is no longer active', async () => {
      const op = await operation();
      const task = await created(op.id, pairKeyOf(op.id, 'pt'));
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;

      await tasks.pauseOperation(op.id, 'STEP_FAILED');
      expect((await taskOf(task.id)).status).toBe('running');

      expect(await tasks.finish(claimed, 'owner', { kind: 'continue' })).toBe(true);
      expect((await taskOf(task.id)).status).toBe('cancelled');
    });

    it('resume right after pause while the step is running: success without a second task', async () => {
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'en');
      const task = await created(op.id, pairKey);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;
      await tasks.pauseOperation(op.id, 'LIMIT_REACHED');

      const [resumed] = await tasks.resumeOperation(op.id, [
        {
          kind: KIND,
          operationId: op.id,
          pairKey,
        },
      ]);

      expect(resumed).toMatchObject({ created: false, holder: { id: task.id } });
      expect(await prisma.llmTask.count({ where: { pairKey } })).toBe(1);
      expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
        'active',
      );
      // Шаг доделан при активной операции - следующий шаг той же строкой.
      await tasks.finish(claimed, 'owner', { kind: 'continue' });
      expect((await taskOf(task.id)).status).toBe('pending');
    });

    it('a step finishing while resume is in flight waits for it: the pair keeps its task (L-019)', async () => {
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'en');
      const task = await created(op.id, pairKey);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;
      await tasks.pauseOperation(op.id, 'LIMIT_REACHED');

      // «Продолжить» держит строку операции незакоммиченной, пока шаг пытается завершиться.
      const finishing: { done?: Promise<boolean> } = {};
      let settledEarly = false;
      await prisma.$transaction(
        async (tx) => {
          await tx.llmOperation.update({ where: { id: op.id }, data: { status: 'active' } });
          finishing.done = tasks.finish(claimed, 'owner', { kind: 'continue' });
          void finishing.done.then(() => (settledEarly = true));
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
        { timeout: 10_000, maxWait: 5_000 },
      );

      expect(settledEarly).toBe(false);
      expect(await finishing.done).toBe(true);
      expect((await taskOf(task.id)).status).toBe('pending');
    });

    it('the orphan cleanup waits for an in-flight resume and keeps the task it took as holder', async () => {
      fakeDateOnly();
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'fr');
      const task = await created(op.id, pairKey);
      await tasks.claim([KIND], 'dead-owner');
      await tasks.pauseOperation(op.id, 'LIMIT_REACHED');
      advance(tasks.leaseMs() + 1);

      const cleaning: { done?: Promise<number> } = {};
      await prisma.$transaction(
        async (tx) => {
          await tx.llmOperation.update({ where: { id: op.id }, data: { status: 'active' } });
          cleaning.done = tasks.cancelOrphanedTasks();
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
        { timeout: 10_000, maxWait: 5_000 },
      );

      expect(await cleaning.done).toBe(0);
      expect((await taskOf(task.id)).status).toBe('running');
    });

    it('resume after the step was cancelled inserts the pair task again', async () => {
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'ru');
      await created(op.id, pairKey);
      await tasks.pauseOperation(op.id, 'LIMIT_REACHED');

      const [resumed] = await tasks.resumeOperation(op.id, [
        {
          kind: KIND,
          operationId: op.id,
          pairKey,
        },
      ]);

      expect(resumed.created).toBe(true);
      expect(await prisma.llmTask.count({ where: { pairKey, status: 'pending' } })).toBe(1);
    });

    it('resume while a chunk retry holds the pair: 409 RETRY_IN_PROGRESS, the operation stays paused', async () => {
      const op = await operation('paused');
      const pairKey = pairKeyOf(op.id, 'fr');
      await enqueue(op.id, { kind: TRANSLATION_RETRY_KIND, pairKey });

      await expect(
        tasks.resumeOperation(op.id, [{ kind: KIND, operationId: op.id, pairKey }]),
      ).rejects.toMatchObject({ status: 409, response: { code: 'RETRY_IN_PROGRESS' } });
      expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
        'paused',
      );
    });

    it('resume of several pairs is one transaction: a retry on the second pair leaves no task for the first', async () => {
      const op = await operation('paused');
      const first = pairKeyOf(op.id, 'es');
      const second = pairKeyOf(op.id, 'fr');
      await enqueue(op.id, { kind: TRANSLATION_RETRY_KIND, pairKey: second });

      await expect(
        tasks.resumeOperation(op.id, [
          { kind: KIND, operationId: op.id, pairKey: first },
          { kind: KIND, operationId: op.id, pairKey: second },
        ]),
      ).rejects.toMatchObject({ status: 409, response: { code: 'RETRY_IN_PROGRESS' } });
      expect(await prisma.llmTask.count({ where: { pairKey: first } })).toBe(0);
      expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
        'paused',
      );
    });

    it('resume refuses a pause reason of the kind in the same write: no task, the pause stays', async () => {
      const op = await operation('paused');
      await prisma.llmOperation.update({
        where: { id: op.id },
        data: { pauseReason: 'DOSSIER_STALE' },
      });
      const pairKey = pairKeyOf(op.id, 'es');

      await expect(
        tasks.resumeOperation(
          op.id,
          [{ kind: KIND, operationId: op.id, pairKey }],
          undefined,
          undefined,
          ['DOSSIER_STALE'],
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: 'LLM_OPERATION_NOT_RESUMABLE' } });
      await expect(
        tasks.resumeOperation(
          op.id,
          [{ kind: KIND, operationId: op.id, pairKey }],
          new Prisma.Decimal(10),
          undefined,
          ['DOSSIER_STALE'],
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'DOSSIER_STALE',
      });
      expect(await prisma.llmTask.count({ where: { pairKey } })).toBe(0);
    });

    it('a stop found by a step: pauses an active operation, re-reasons a paused one except kept reasons, writes nothing to a cancelled one', async () => {
      const writes: string[] = [];
      const write = (tag: string) => () => {
        writes.push(tag);
        return Promise.resolve();
      };
      const active = await operation();
      await enqueue(active.id);
      expect(await tasks.stopOrRepause(active.id, 'STEP_FAILED', write('active'))).toBe(true);
      expect(
        await prisma.llmOperation.findUniqueOrThrow({ where: { id: active.id } }),
      ).toMatchObject({
        status: 'paused',
        pauseReason: 'STEP_FAILED',
      });
      expect(
        await prisma.llmTask.count({ where: { operationId: active.id, status: 'pending' } }),
      ).toBe(0);

      const stale = await operation('paused');
      await prisma.llmOperation.update({
        where: { id: stale.id },
        data: { pauseReason: 'DOSSIER_STALE' },
      });
      expect(
        await tasks.stopOrRepause(stale.id, 'NO_COMPLIANT_PROVIDER', write('stale'), [
          'DOSSIER_STALE',
        ]),
      ).toBe(false);
      expect(
        (await prisma.llmOperation.findUniqueOrThrow({ where: { id: stale.id } })).pauseReason,
      ).toBe('DOSSIER_STALE');

      const button = await operation('paused');
      expect(await tasks.stopOrRepause(button.id, 'NO_COMPLIANT_PROVIDER', write('button'))).toBe(
        true,
      );
      expect(
        (await prisma.llmOperation.findUniqueOrThrow({ where: { id: button.id } })).pauseReason,
      ).toBe('NO_COMPLIANT_PROVIDER');

      const cancelled = await operation();
      await tasks.cancelOperation(cancelled.id);
      expect(await tasks.stopOrRepause(cancelled.id, 'DOSSIER_STALE', write('cancelled'))).toBe(
        false,
      );
      expect(writes).toEqual(['active', 'button']);
    });

    it('a pair held by a task of another operation is an invariant breach, not a success', async () => {
      const other = await operation();
      const op = await operation('paused');
      const pairKey = pairKeyOf(op.id, 'es');
      await created(other.id, pairKey);

      await expect(
        tasks.resumeOperation(op.id, [{ kind: KIND, operationId: op.id, pairKey }]),
      ).rejects.toMatchObject({ status: 500 });
      expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
        'paused',
      );
    });

    it('a step stopped mid-call by a pause ends cancelled, not failed (Р19)', async () => {
      process.env.OPENROUTER_API_KEY = FAKE_KEY;
      const op = await operation();
      const task = await created(op.id, pairKeyOf(op.id, 'ru'));
      step = async () => {
        await tasks.pauseOperation(op.id, 'LIMIT_REACHED');
        // Резерв следующего вызова видит операцию не `active`.
        await budget.reserve({
          operationId: op.id,
          stage: 'e2e_worker_stage',
          requestedModel: 'a/priced',
          attempt: 1,
          estimateUsd: new Prisma.Decimal('0.01'),
        });
        return { kind: 'done' };
      };

      await worker.runOnce();

      expect((await taskOf(task.id)).status).toBe('cancelled');
      expect(onFailed).not.toHaveBeenCalled();
    });

    it('release hands a task back as pending without counting the claim', async () => {
      const op = await operation();
      const task = await created(op.id);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;

      expect(await tasks.release(claimed, 'owner')).toBe(true);
      expect(await taskOf(task.id)).toMatchObject({
        status: 'pending',
        attempt: 0,
        ownerToken: null,
      });
      expect(await tasks.release(claimed, 'owner')).toBe(false); // уже не наша
    });

    it('release does not count the interrupted claim, but keeps the earlier ones', async () => {
      fakeDateOnly();
      const op = await operation();
      const task = await created(op.id);
      await tasks.claim([KIND], 'lost');
      advance(tasks.leaseMs() + 1);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;
      expect(claimed.attempt).toBe(2);

      await tasks.release(claimed, 'owner');
      expect((await taskOf(task.id)).attempt).toBe(1);
    });

    it('release of a task of a stopped operation closes it cancelled, freeing the pair', async () => {
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'es');
      const task = await created(op.id, pairKey);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;
      await tasks.pauseOperation(op.id, 'LIMIT_REACHED');

      expect(await tasks.release(claimed, 'owner')).toBe(true);
      expect((await taskOf(task.id)).status).toBe('cancelled');
      expect((await tasks.enqueue({ kind: KIND, operationId: op.id, pairKey })).created).toBe(true);
    });

    it('a claim racing a pause takes no lock on the operation: no deadlock (L-019)', async () => {
      const op = await operation();
      const task = await created(op.id);

      // Пауза: строка операции заперта первой, задачи - вторыми (`stopOperation`).
      let claimed: Promise<LlmTask | null> | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.llmOperation.update({ where: { id: op.id }, data: { status: 'paused' } });
          claimed = tasks.claim([KIND], 'racer');
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.llmTask.updateMany({
            where: { operationId: op.id, status: 'pending' },
            data: { status: 'cancelled' },
          });
        },
        { timeout: 10_000, maxWait: 5_000 },
      );

      // Захват прочитал операцию снимком (ещё `active`) и взял задачу - шаг её доделает
      // и закроет `cancelled` (Р19); главное - обе стороны завершились без 40P01.
      const won = await claimed;
      expect(won?.id).toBe(task.id);
      expect((await taskOf(task.id)).status).toBe('running');
    });

    it('a running task with an expired lease of a stopped operation is closed by the cleanup', async () => {
      fakeDateOnly();
      const op = await operation();
      const pairKey = pairKeyOf(op.id, 'pt');
      const task = await created(op.id, pairKey);
      await tasks.claim([KIND], 'dead-owner');
      await tasks.cancelOperation(op.id);
      expect(await tasks.cancelOrphanedTasks()).toBe(0); // аренда ещё жива

      advance(tasks.leaseMs() + 1);
      expect(await tasks.cancelOrphanedTasks()).toBe(1);
      expect(await taskOf(task.id)).toMatchObject({ status: 'cancelled', ownerToken: null });
      // Ключ пары свободен.
      const again = await tasks.enqueue({ kind: KIND, operationId: op.id, pairKey });
      expect(again.created).toBe(true);
    });

    it('a cancelled operation cannot be resumed', async () => {
      const op = await operation();
      await tasks.cancelOperation(op.id);
      await expect(
        tasks.resumeOperation(op.id, [{ kind: KIND, operationId: op.id }]),
      ).rejects.toMatchObject({ status: 409, response: { code: 'LLM_OPERATION_NOT_RESUMABLE' } });
    });
  });

  describe('step results', () => {
    it('fail returned by the handler: failed with its reason, onFailed is not called', async () => {
      const op = await operation();
      const task = await created(op.id);
      step = () => Promise.resolve({ kind: 'fail', reason: 'SOURCE_MISSING' });

      await worker.runOnce();

      expect(await taskOf(task.id)).toMatchObject({
        status: 'failed',
        lastError: 'SOURCE_MISSING',
      });
      expect(onFailed).not.toHaveBeenCalled();
    });

    it('wait on an operation that is no longer active ends cancelled', async () => {
      const op = await operation();
      const task = await created(op.id);
      const claimed = (await tasks.claim([KIND], 'owner')) as LlmTask;
      await tasks.cancelOperation(op.id);

      expect(await tasks.finish(claimed, 'owner', { kind: 'wait', reason: 'dossier' })).toBe(true);
      expect((await taskOf(task.id)).status).toBe('cancelled');
    });
  });

  describe('step failures (Р-Ж)', () => {
    it.each<[string, () => Error, string]>([
      ['an LlmError', () => new LlmError('LLM_UNAVAILABLE', 'down'), 'LLM_UNAVAILABLE'],
      [
        'a 503 of the LLM module',
        () => new ServiceUnavailableException({ statusCode: 503, code: 'LLM_DISABLED' }),
        'LLM_DISABLED',
      ],
      ['an unrecognised exception', () => new TypeError('boom'), 'STEP_ERROR'],
    ])('%s fails the step with its code and tells the handler', async (_name, error, code) => {
      const op = await operation();
      const task = await created(op.id);
      step = () => Promise.reject(error());

      await worker.runOnce();

      expect(await taskOf(task.id)).toMatchObject({ status: 'failed', lastError: code });
      expect(onFailed).toHaveBeenCalledTimes(1);
    });

    it('a lost lease inside the step writes nothing', async () => {
      fakeDateOnly();
      const op = await operation();
      const task = await created(op.id);
      step = async (_task, ctx) => {
        advance(tasks.leaseMs() + 1);
        await tasks.claim([KIND], 'thief');
        await ctx.renewLease();
        return { kind: 'done' };
      };

      await worker.runOnce();

      expect(await taskOf(task.id)).toMatchObject({ status: 'running', ownerToken: 'thief' });
      expect(onFailed).not.toHaveBeenCalled();
    });
  });

  describe('dates in raw SQL', () => {
    it('a session time zone other than UTC does not shift utcTimestamp', async () => {
      const at = new Date('2026-10-21T10:00:00.000Z');
      const [row] = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Europe/Moscow'`;
        return tx.$queryRaw<Array<{ utc: string }>>`
          SELECT to_char(${utcTimestamp(at)}, 'YYYY-MM-DD"T"HH24:MI:SS') AS "utc"`;
      });
      // Значение - `timestamp` без пояса в UTC, как колонки, которые пишет Prisma.
      expect(row.utc).toBe('2026-10-21T10:00:00');
    });
  });

  describe('stale call cleanup (Р21)', () => {
    it('a call stuck for a month is closed too: its age does not overflow durationMs', async () => {
      const op = await operation();
      const { callId } = await budget.reserve({
        operationId: op.id,
        stage: 'e2e_worker_stage',
        requestedModel: 'a/priced',
        attempt: 1,
        estimateUsd: new Prisma.Decimal('0.01'),
      });
      await prisma.llmCall.update({
        where: { id: callId },
        data: { startedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      });

      expect(await budget.releaseStaleCalls(1_000)).toBeGreaterThanOrEqual(1);
      const call = await prisma.llmCall.findUniqueOrThrow({ where: { id: callId } });
      expect(call).toMatchObject({ errorClass: 'stale', durationMs: 2_147_483_647 });
    });

    // Так же, как пишет Prisma: `Date` процесса, `timestamp` без пояса в UTC.
    const backdate = (callId: string, seconds: number) =>
      prisma.llmCall.update({
        where: { id: callId },
        data: { startedAt: new Date(Date.now() - seconds * 1000) },
      });

    it('does not touch a call before timeout + 60 s, then books fact = reserve', async () => {
      const op = await operation();
      const before = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
      const { callId } = await budget.reserve({
        operationId: op.id,
        stage: 'e2e_worker_stage',
        requestedModel: 'a/priced',
        attempt: 1,
        estimateUsd: new Prisma.Decimal('0.25'),
      });

      await backdate(callId, 1 + 55);
      expect(await budget.releaseStaleCalls(1_000)).toBe(0);
      expect(
        (await prisma.llmCall.findUniqueOrThrow({ where: { id: callId } })).reserveReleasedAt,
      ).toBeNull();

      await backdate(callId, 1 + 65);
      expect(await budget.releaseStaleCalls(1_000)).toBe(1);

      const call = await prisma.llmCall.findUniqueOrThrow({ where: { id: callId } });
      expect(call.costUsd?.toString()).toBe('0.25');
      expect(call).toMatchObject({ costEstimated: true, errorClass: 'stale' });
      const after = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
      expect(after.spentUsd.sub(before.spentUsd).toString()).toBe('0.25');
      expect(after.reservedUsd.equals(before.reservedUsd)).toBe(true);
      const opRow = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
      expect(opRow.spentUsd.toString()).toBe('0.25');
      expect(opRow.reservedUsd.isZero()).toBe(true);
      // Поздний факт живого процесса после чистки не пишет ничего (Р21).
      expect(
        await budget.settle(callId, {
          costUsd: new Prisma.Decimal('0.01'),
          costEstimated: false,
          durationMs: 1,
        }),
      ).toBe(false);
    });
  });

  it('the worker timer is not running without a key: tasks are not taken (Р25)', async () => {
    const op = await operation();
    const task = await created(op.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await taskOf(task.id)).status).toBe('pending');
  });
});
