import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { BatchCallRow, LlmBudgetService, ReserveInput, SettleInput } from './llm-budget.service';
import { LlmConfig } from './llm.config';
import { LlmBatchPendingError } from './llm.errors';
import { batchBaseModel } from './openrouter-batch';
import { LlmCallModel, LlmChatRequest, OpenRouterClient } from './openrouter.client';

/**
 * Модели `:batch` через Batch API OpenRouter (решения арбитра 14.11.2026,
 * `2026-11-14-llm-batch-models`): батч на один запрос, шаг ждёт `LlmBatchPendingError`, повтор шага
 * находит батч по отпечатку и не отправляет его второй раз. Формы ответа - с живой пробы 14.11.2026.
 * Строки `LlmCall` - копиями, как из базы: клиент видит снимок, а не общий объект.
 */
const KEY = 'sk-or-test-secret-key-0123456789';

const batchModel = (id: string): LlmCallModel => ({
  id,
  inputPrice: new Prisma.Decimal('0.0000005'),
  outputPrice: new Prisma.Decimal('0.0000025'),
  structuredOutputs: true,
  batch: true,
});
const syncModel = (id: string): LlmCallModel => ({
  id,
  inputPrice: new Prisma.Decimal('0.000001'),
  outputPrice: new Prisma.Decimal('0.000002'),
  structuredOutputs: true,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const created = (id: string) =>
  json(202, {
    id,
    object: 'batch',
    endpoint: '/v1/chat/completions',
    model: 'openai/gpt-6-luna-20260922',
    status: 'validating',
    request_counts: { total: 1, completed: 0, failed: 0 },
    usage: null,
    results: null,
    error: null,
  });
const inProgress = (id: string) => json(200, { id, status: 'in_progress', results: null });
const answerBody = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'openai/gpt-6-luna-20260922',
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
  ...extra,
});
const completed = (id: string, customId: string, content: string, cost: number | null = 0.00042) =>
  json(200, {
    id,
    status: 'completed',
    provider: 'OpenAI',
    usage: cost === null ? null : { cost },
    results: [{ custom_id: customId, response: answerBody(content) }],
  });
const syncAnswer = (content: string, cost = 0.001) =>
  json(200, {
    model: 'b/fallback',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost },
  });

type Row = BatchCallRow & { batchKey: string | null };

describe('OpenRouterClient - models `:batch`', () => {
  let fetchSpy: jest.SpyInstance;
  let rows: Map<string, Row>;
  let settled: Array<{ id: string } & SettleInput>;
  let budget: Record<string, jest.Mock>;
  let client: OpenRouterClient;

  const request = (over: Partial<LlmChatRequest> = {}): LlmChatRequest => ({
    operationId: 'op-1',
    stage: 'translate',
    models: [batchModel('openai/gpt-6-luna:batch'), syncModel('b/fallback')],
    messages: [{ role: 'user', content: 'secret book text' }],
    temperature: 0.2,
    maxTokens: 1000,
    taskId: 'task-1',
    jsonSchema: { name: 'a', schema: {} },
    ...over,
  });
  const only = { models: [batchModel('openai/gpt-6-luna:batch')] };

  const calls = () =>
    fetchSpy.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body
        ? (JSON.parse((init as RequestInit).body as string) as Record<string, unknown>)
        : null,
    }));
  const posts = () => calls().filter((c) => c.method === 'POST' && c.url.endsWith('/batches'));
  const pending = (over: Partial<LlmChatRequest> = {}) =>
    expect(client.chat(request(over))).rejects.toBeInstanceOf(LlmBatchPendingError);

  beforeEach(() => {
    const env: Record<string, string> = { OPENROUTER_API_KEY: KEY, LLM_CALL_TIMEOUT_MS: '50' };
    const config = new LlmConfig({ get: (k: string) => env[k] } as unknown as ConfigService);
    rows = new Map();
    settled = [];
    let n = 0;
    budget = {
      reserve: jest.fn((input: ReserveInput) => {
        const id = `call-${++n}`;
        rows.set(id, {
          id,
          operationId: input.operationId,
          stage: input.stage,
          requestedModel: input.requestedModel,
          attempt: input.attempt,
          reservedUsd: new Prisma.Decimal('0.01'),
          startedAt: new Date(),
          batchId: null,
          batchKey: input.batchKey ?? null,
          batchStatus: null,
          taskId: input.taskId ?? null,
          reserveReleasedAt: null,
          costUsd: null,
          errorClass: null,
        });
        return Promise.resolve({ callId: id });
      }),
      settle: jest.fn((id: string, input: SettleInput) => {
        const row = rows.get(id);
        if (!row || row.reserveReleasedAt) return Promise.resolve(false);
        row.reserveReleasedAt = new Date();
        row.costUsd = input.costUsd;
        row.errorClass = input.errorClass ?? null;
        if (input.batchStatus) row.batchStatus = input.batchStatus;
        settled.push({ id, ...input });
        return Promise.resolve(true);
      }),
      // Как в базе: id батча - только в открытую строку.
      markBatchSubmitted: jest.fn((id: string, batch: { batchId: string; status: string }) => {
        const row = rows.get(id);
        if (!row || row.reserveReleasedAt) return Promise.resolve(false);
        Object.assign(row, { batchId: batch.batchId, batchStatus: batch.status });
        return Promise.resolve(true);
      }),
      findBatchCall: jest.fn((operationId: string, key: string) => {
        const row = [...rows.values()]
          .reverse()
          .find((r) => r.operationId === operationId && r.batchKey === key);
        return Promise.resolve(row ? { ...row } : null);
      }),
      // Как в базе: отметка опроса - только у открытой строки (условие в самом UPDATE).
      touchBatch: jest.fn((id: string, status: string | null) => {
        const row = rows.get(id);
        if (!row || row.reserveReleasedAt) return Promise.resolve(false);
        if (status !== null) row.batchStatus = status;
        return Promise.resolve(true);
      }),
      markBatchTaken: jest.fn((id: string, status: string) => {
        const row = rows.get(id);
        if (row) row.batchStatus = status;
        return Promise.resolve();
      }),
      callCost: jest.fn((id: string) => Promise.resolve(rows.get(id)?.costUsd ?? null)),
      openBatchCalls: jest.fn(() =>
        Promise.resolve(
          [...rows.values()]
            .filter((r) => r.batchId && !r.reserveReleasedAt)
            .map((r) => ({ ...r })),
        ),
      ),
    };
    client = new OpenRouterClient(config, budget as unknown as LlmBudgetService);
    jest.spyOn(client as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('отправка', () => {
    it('one request to /batches: base model, no provider, custom_id = call, key written by the reserve', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1'));

      await pending();

      const [submit] = calls();
      expect(submit.url).toMatch(/\/batches$/);
      expect(submit.method).toBe('POST');
      // Поля до `requests` - первыми (иначе 400); базовое имя модели, `:batch` резолвит API.
      expect(Object.keys(submit.body ?? {})).toEqual([
        'endpoint',
        'model',
        'completion_window',
        'requests',
      ]);
      expect(submit.body?.model).toBe('openai/gpt-6-luna');
      const inner = (
        submit.body?.requests as Array<{ custom_id: string; body: Record<string, unknown> }>
      )[0];
      expect(inner.custom_id).toBe('call-1');
      expect(inner.body.model).toBe('openai/gpt-6-luna');
      // Batch API отвергает `data_collection` (живая проба: 400 «Unrecognized key»).
      expect(inner.body.provider).toBeUndefined();
      expect(inner.body.response_format).toBeDefined();
      // Отпечаток - в той же транзакции, что резерв: до отправки.
      expect((budget.reserve.mock.calls[0][0] as ReserveInput).batchKey).toMatch(/^[0-9a-f]{64}$/);
      expect(rows.get('call-1')).toMatchObject({ batchId: 'batch-1', batchStatus: 'validating' });
      expect(settled).toHaveLength(0);
    });

    it('a lost answer to the submit books fact = reserve and never submits the same request again', async () => {
      fetchSpy
        .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
        .mockResolvedValueOnce(syncAnswer('{"answer":5}'));

      const result = await client.chat(request());

      expect(result.json).toEqual({ answer: 5 });
      expect(settled[0]).toMatchObject({
        id: 'call-1',
        errorClass: 'batch_submit_lost',
        costEstimated: true,
      });
      const reserve = (budget.reserve.mock.calls[0][0] as ReserveInput).estimateUsd;
      expect(settled[0].costUsd.equals(reserve)).toBe(true);
      // Повтор шага той же задачей: батч не уходит снова - сразу запасная.
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"answer":6}'));
      await client.chat(request());
      expect(posts()).toHaveLength(1);
    });

    it('a 2xx submit answer without a batch id is a lost submit: fact = reserve, no second batch', async () => {
      fetchSpy
        .mockResolvedValueOnce(json(202, { object: 'batch' }))
        .mockResolvedValueOnce(syncAnswer('{"answer":8}'));

      expect((await client.chat(request())).json).toEqual({ answer: 8 });
      expect(settled[0]).toMatchObject({ errorClass: 'batch_submit_lost', costEstimated: true });
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"answer":9}'));
      await client.chat(request());
      expect(posts()).toHaveLength(1);
    });

    it('a submit that never connected books zero and retries the same model', async () => {
      fetchSpy
        .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
        .mockResolvedValueOnce(created('batch-1'));

      await pending();

      expect(settled[0]).toMatchObject({ errorClass: 'connect', costEstimated: false });
      expect(settled[0].costUsd.isZero()).toBe(true);
      expect(posts()).toHaveLength(2);
    });

    it('a submit failing to write its batch id waits for the cleanup, never submits twice', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1'));
      budget.markBatchSubmitted.mockRejectedValueOnce(new Error('db down'));

      await expect(client.chat(request())).rejects.toThrow('db down');
      await pending();
      expect(posts()).toHaveLength(1);

      // Чистка зависших закрыла строку без id: дальше - запасная, не второй батч.
      rows.get('call-1')!.reserveReleasedAt = new Date();
      rows.get('call-1')!.errorClass = 'stale';
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"answer":1}'));
      expect((await client.chat(request())).json).toEqual({ answer: 1 });
      expect(posts()).toHaveLength(1);
    });

    it('a batch created after its row was closed by the stale cleanup is an orphan: fallback, logged', async () => {
      fetchSpy.mockImplementationOnce(() => {
        // Чистка зависших закрыла строку, пока шла отправка.
        const row = rows.get('call-1')!;
        row.reserveReleasedAt = new Date();
        row.errorClass = 'stale';
        return Promise.resolve(created('batch-late'));
      });
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"o":1}'));

      const result = await client.chat(request());

      expect(result.json).toEqual({ o: 1 });
      expect(budget.markBatchSubmitted).toHaveBeenCalledTimes(1);
      expect(rows.get('call-1')?.batchId).toBeNull();
      expect(posts()).toHaveLength(1);
    });

    it('an aborted step between the reserve and the submit books zero and sends nothing', async () => {
      const abort = new AbortController();
      budget.reserve.mockImplementationOnce((input: ReserveInput) => {
        abort.abort();
        rows.set('call-x', {
          id: 'call-x',
          operationId: input.operationId,
          stage: input.stage,
          requestedModel: input.requestedModel,
          attempt: 1,
          reservedUsd: new Prisma.Decimal('0.01'),
          startedAt: new Date(),
          batchId: null,
          batchKey: input.batchKey ?? null,
          batchStatus: null,
          taskId: input.taskId ?? null,
          reserveReleasedAt: null,
          costUsd: null,
          errorClass: null,
        });
        return Promise.resolve({ callId: 'call-x' });
      });

      await expect(client.chat(request({ signal: abort.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(settled[0]).toMatchObject({ errorClass: 'aborted', costEstimated: false });
      expect(settled[0].costUsd.isZero()).toBe(true);
    });

    it('402 on submit is LLM_INSUFFICIENT_FUNDS and books zero', async () => {
      fetchSpy.mockResolvedValueOnce(json(402, { error: { code: 402, message: 'no money' } }));

      await expect(client.chat(request())).rejects.toMatchObject({
        code: 'LLM_INSUFFICIENT_FUNDS',
      });
      expect(settled[0].costUsd.isZero()).toBe(true);
    });

    it('400 on submit is LLM_PROVIDER_ERROR and books zero', async () => {
      fetchSpy.mockResolvedValueOnce(json(400, { error: { code: 400, message: 'bad' } }));

      await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
      expect(settled[0].costUsd.isZero()).toBe(true);
      expect(rows.get('call-1')?.batchId).toBeNull();
    });

    it('429 on submit (batch not created) moves to the fallback', async () => {
      fetchSpy
        .mockResolvedValueOnce(json(429, { error: { code: 429 } }))
        .mockResolvedValueOnce(syncAnswer('{"a":1}'));
      expect((await client.chat(request())).json).toEqual({ a: 1 });
      expect(settled[0].costUsd.isZero()).toBe(true);
    });

    it.each([502, 503, 504, 408])(
      '%i on submit is a lost submit: fact = reserve, fallback, never a second batch',
      async (status) => {
        fetchSpy
          .mockResolvedValueOnce(json(status, { error: { code: status } }))
          .mockResolvedValueOnce(syncAnswer('{"a":2}'))
          .mockResolvedValueOnce(syncAnswer('{"a":3}'));

        expect((await client.chat(request())).json).toEqual({ a: 2 });
        expect(settled[0]).toMatchObject({ errorClass: 'batch_submit_lost', costEstimated: true });
        await client.chat(request());
        expect(posts()).toHaveLength(1);
      },
    );

    it('a request that could not be built locally fails like a sync call, without retries', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Invalid URL'));

      await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settled[0]).toMatchObject({ errorClass: 'local', costEstimated: false });
    });

    it('"no endpoints" on submit goes straight to the fallback', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          json(404, { error: { code: 404, message: 'No endpoints found for x' } }),
        )
        .mockResolvedValueOnce(syncAnswer('{"a":2}'));

      expect((await client.chat(request())).json).toEqual({ a: 2 });
      expect(posts()).toHaveLength(1);
    });
  });

  describe('ожидание и ответ', () => {
    it('a step re-run polls the same batch and never submits it a second time', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(inProgress('batch-1'));

      await pending();
      await pending();

      expect(calls().map((c) => `${c.method} ${c.url.replace(/^.*\/api\/v1/, '')}`)).toEqual([
        'POST /batches',
        'GET /batches/batch-1',
      ]);
      expect(budget.reserve).toHaveBeenCalledTimes(1);
      expect(rows.get('call-1')?.batchStatus).toBe('in_progress');
    });

    it('a finished batch answers like a sync call; the fact is the batch usage.cost, once', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"answer":42}'));

      await pending();
      const result = await client.chat(request());

      expect(result.json).toEqual({ answer: 42 });
      expect(result.callId).toBe('call-1');
      expect(result.costUsd.toFixed(8)).toBe('0.00042000');
      expect(result.provider).toBe('OpenAI');
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        id: 'call-1',
        costEstimated: false,
        errorClass: null,
        batchStatus: 'completed',
      });
      expect(rows.get('call-1')?.batchStatus).toBe('consumed');
    });

    it('an answer read again reports its cost again (a step pass sums its calls), booked once', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"answer":42}'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"answer":42}'));

      await pending();
      expect((await client.chat(request())).costUsd.toFixed(8)).toBe('0.00042000');
      const again = await client.chat(request());

      expect(again.json).toEqual({ answer: 42 });
      expect(again.costUsd.toFixed(8)).toBe('0.00042000');
      expect(settled).toHaveLength(1);
    });

    it('when housekeeping closed the row first, the step reports the recorded cost', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"a":1}', null));
      await pending();
      // Шаг прочитал строку открытой, а чистка закрыла её раньше его записи.
      budget.findBatchCall.mockImplementationOnce(() => {
        const snapshot = { ...rows.get('call-1')! };
        const live = rows.get('call-1')!;
        live.reserveReleasedAt = new Date();
        live.costUsd = new Prisma.Decimal('0.01');
        return Promise.resolve(snapshot);
      });

      const result = await client.chat(request());

      expect(result.costUsd.toFixed(8)).toBe('0.01000000');
      expect(settled).toHaveLength(0);
    });

    it('a batch closed by housekeeping is read without a second fact and counted once', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"answer":1}'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"answer":1}'));

      await pending();
      expect(await client.pollOpenBatches(new Date(), 20)).toBe(1);
      const result = await client.chat(request());

      expect(result.json).toEqual({ answer: 1 });
      expect(settled).toHaveLength(1);
      expect(result.costUsd.toFixed(8)).toBe('0.00042000');
    });

    it('without usage.cost the fact is tokens × the model price, marked as an estimate', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"a":1}', null));

      await pending();
      const result = await client.chat(request());

      // 120 × 0.0000005 + 30 × 0.0000025
      expect(result.costUsd.toFixed(8)).toBe('0.00013500');
      expect(settled[0].costEstimated).toBe(true);
    });

    it('the answer may come wrapped in response.body', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(
        json(200, {
          id: 'batch-1',
          status: 'completed',
          usage: { cost: 0.0001 },
          results: [
            { custom_id: 'call-1', response: { status_code: 200, body: answerBody('{"x":9}') } },
          ],
        }),
      );

      await pending();
      expect((await client.chat(request())).json).toEqual({ x: 9 });
    });

    it('an unknown batch status keeps waiting (no fallback paid while the batch may still run)', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(json(200, { id: 'batch-1', status: 'queued', usage: null }));

      await pending();
      await pending();
      expect(settled).toHaveLength(0);
      expect(calls().filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(0);
      expect(rows.get('call-1')?.batchStatus).toBe('queued');
    });

    it('a failed poll does not overwrite the batch status with a made-up one', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(inProgress('batch-1'))
        .mockResolvedValueOnce(json(503, {}));

      await pending();
      await pending();
      await pending();
      expect(rows.get('call-1')?.batchStatus).toBe('in_progress');
    });

    it('a poll that read the row open does not touch it once it is closed', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1'));
      await pending();
      rows.get('call-1')!.reserveReleasedAt = new Date();
      rows.get('call-1')!.batchStatus = 'consumed';

      expect(await budget.touchBatch('call-1', 'in_progress')).toBe(false);
      expect(rows.get('call-1')?.batchStatus).toBe('consumed');
    });

    it('a network failure while polling keeps waiting, not failing', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
        .mockResolvedValueOnce(json(503, {}));

      await pending();
      await pending();
      await pending();
      expect(settled).toHaveLength(0);
    });

    it('a different request is a new batch', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(created('batch-2'));

      await pending();
      await pending({ messages: [{ role: 'user', content: 'another piece' }] });

      expect(budget.reserve).toHaveBeenCalledTimes(2);
      expect(posts()).toHaveLength(2);
    });
  });

  describe('отказы батча', () => {
    it('an expired batch books zero and moves to the fallback model with data_collection deny', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(json(200, { id: 'batch-1', status: 'expired', usage: null }))
        .mockResolvedValueOnce(syncAnswer('{"answer":7}'));

      await pending();
      const result = await client.chat(request());

      expect(result.json).toEqual({ answer: 7 });
      expect(settled[0]).toMatchObject({ id: 'call-1', errorClass: 'batch_expired' });
      expect(settled[0].costUsd.isZero()).toBe(true);
      const last = calls().at(-1);
      expect(last?.url).toMatch(/\/chat\/completions$/);
      expect(last?.body?.provider).toEqual({ data_collection: 'deny' });
    });

    it('a failed batch that reports a cost books that cost', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(
          json(200, { id: 'batch-1', status: 'failed', usage: { cost: 0.0003 } }),
        );

      await pending(only);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0].costUsd.toFixed(8)).toBe('0.00030000');
    });

    it('a failed request inside a completed batch, or a status_code >= 400, is a model failure', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(
        json(200, {
          id: 'batch-1',
          status: 'completed',
          usage: { cost: 0 },
          results: [{ custom_id: 'call-1', error: { code: 'server_error', message: 'boom' } }],
        }),
      );
      await pending(only);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0]).toMatchObject({ errorClass: 'batch_request_failed' });

      fetchSpy.mockResolvedValueOnce(created('batch-2')).mockResolvedValueOnce(
        json(200, {
          id: 'batch-2',
          status: 'completed',
          usage: { cost: 0 },
          results: [{ custom_id: 'call-2', response: { status_code: 500, body: {} } }],
        }),
      );
      const other = { ...only, messages: [{ role: 'user' as const, content: 'x' }] };
      await pending(other);
      await expect(client.chat(request(other))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[1]).toMatchObject({ errorClass: 'batch_http_500' });
    });

    it('a completed batch without its own result books the cost or the reserve, not an exact zero', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(
          json(200, { id: 'batch-1', status: 'completed', usage: null, results: [] }),
        );

      await pending(only);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0]).toMatchObject({ errorClass: 'batch_result_missing', costEstimated: true });
      expect(settled[0].costUsd.toFixed(8)).toBe('0.01000000');
    });

    it('a result whose response is not an object is a missing result, not an answer', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(
        json(200, {
          id: 'batch-1',
          status: 'completed',
          usage: { cost: 0.0002 },
          results: [{ custom_id: 'call-1', response: 'oops' }],
        }),
      );

      await pending(only);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0]).toMatchObject({
        errorClass: 'batch_result_missing',
        costEstimated: false,
      });
      expect(settled[0].costUsd.toFixed(8)).toBe('0.00020000');
    });

    it('a vanished batch (404/410) books zero and fails the model', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(json(410, {}));

      await pending(only);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0]).toMatchObject({ errorClass: 'batch_gone' });
      expect(settled[0].costUsd.isZero()).toBe(true);
    });

    it.each([400, 401, 403])(
      'a poll refused with %i keeps waiting (the batch may live), no fallback paid',
      async (code) => {
        fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(json(code, {}));

        await pending();
        await pending();
        expect(settled).toHaveLength(0);
        expect(calls().filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(0);
        expect(rows.get('call-1')?.batchStatus).toBe('validating');
      },
    );

    it('a refused poll past the deadline still ends at fact = reserve', async () => {
      fetchSpy.mockResolvedValueOnce(created('batch-1')).mockResolvedValueOnce(json(401, {}));

      await pending(only);
      rows.get('call-1')!.startedAt = new Date(Date.now() - 101 * 3600_000);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0]).toMatchObject({ errorClass: 'batch_timeout', costEstimated: true });
      expect(settled[0].costUsd.toFixed(8)).toBe('0.01000000');
    });

    it('a batch past the deadline fails the model at fact = reserve', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(inProgress('batch-1'));

      await pending(only);
      rows.get('call-1')!.startedAt = new Date(Date.now() - 101 * 3600_000);
      await expect(client.chat(request(only))).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(settled[0]).toMatchObject({ errorClass: 'batch_timeout', costEstimated: true });
    });
  });

  describe('повтор шага и «продолжить»', () => {
    it('after a cut-off of an earlier model the :batch fallback is not called (resume would lose it)', async () => {
      const chain = {
        models: [syncModel('a/sync'), batchModel('openai/gpt-6-luna:batch')],
        truncationEndsModel: true,
      };
      fetchSpy.mockResolvedValueOnce(
        json(200, {
          model: 'a/sync',
          choices: [{ message: { content: '{"cut' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 1000, cost: 0.002 },
        }),
      );

      await expect(client.chat(request(chain))).rejects.toMatchObject({
        name: 'LlmTruncatedError',
      });
      expect(posts()).toHaveLength(0);
    });

    it('resume skips a failed batch: sync models between it and the waiting batch are not called', async () => {
      const chain = {
        models: [
          batchModel('openai/gpt-6-luna:batch'),
          syncModel('y/sync'),
          batchModel('anthropic/claude-haiku-5.5:batch'),
        ],
      };
      fetchSpy
        .mockResolvedValueOnce(created('batch-x'))
        .mockResolvedValueOnce(json(200, { id: 'batch-x', status: 'failed', usage: null }))
        .mockResolvedValueOnce(json(500, { error: { code: 500 } }))
        .mockResolvedValueOnce(json(500, { error: { code: 500 } }))
        .mockResolvedValueOnce(json(500, { error: { code: 500 } }))
        .mockResolvedValueOnce(created('batch-z'));

      await pending(chain);
      await pending(chain);
      const syncBefore = calls().filter((c) => c.url.endsWith('/chat/completions')).length;
      fetchSpy
        .mockResolvedValueOnce(inProgress('batch-z'))
        .mockResolvedValueOnce(inProgress('batch-z'));

      await pending(chain);
      await pending(chain);

      const sync = calls().filter((c) => c.url.endsWith('/chat/completions'));
      expect(sync).toHaveLength(syncBefore);
      expect(
        calls()
          .slice(-2)
          .map((c) => c.url),
      ).toEqual([
        expect.stringMatching(/\/batches\/batch-z$/),
        expect.stringMatching(/\/batches\/batch-z$/),
      ]);
    });

    it('the same :batch model twice in the chain: resume by its first place, the sync fallback between is tried', async () => {
      const d = batchModel('openai/gpt-6-luna:batch');
      const chain = { models: [d, syncModel('a/sync'), d] };
      fetchSpy
        .mockResolvedValueOnce(created('batch-d'))
        .mockResolvedValueOnce(json(200, { id: 'batch-d', status: 'failed', usage: null }))
        .mockResolvedValueOnce(syncAnswer('{"g":1}'));

      await pending(chain);
      const result = await client.chat(request(chain));

      expect(result.json).toEqual({ g: 1 });
      expect(calls().filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(1);
    });

    it('models before a waiting batch are not called again on each poll', async () => {
      const chain = { models: [syncModel('a/sync'), batchModel('openai/gpt-6-luna:batch')] };
      fetchSpy
        .mockResolvedValueOnce(json(429, { error: { code: 429 } }))
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(inProgress('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-2', '{"z":1}'));

      await pending(chain);
      await pending(chain);
      expect((await client.chat(request(chain))).json).toEqual({ z: 1 });

      const sync = calls().filter((c) => c.url.endsWith('/chat/completions'));
      expect(sync).toHaveLength(1);
    });

    it('«Continue» after a pause (a new task) finds the open batch and does not pay twice', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{"answer":3}'));

      await pending({ taskId: 'task-1' });
      const result = await client.chat(request({ taskId: 'task-2' }));

      expect(result.json).toEqual({ answer: 3 });
      expect(posts()).toHaveLength(1);
      expect(budget.reserve).toHaveBeenCalledTimes(1);
    });

    it('a failed batch is retried only by a new task (after «Continue»), not by the same one', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(json(200, { id: 'batch-1', status: 'failed', usage: null }))
        .mockResolvedValueOnce(created('batch-2'));

      await pending({ ...only, taskId: 'task-1' });
      await expect(client.chat(request({ ...only, taskId: 'task-1' }))).rejects.toMatchObject({
        code: 'LLM_UNAVAILABLE',
      });
      await expect(client.chat(request({ ...only, taskId: 'task-1' }))).rejects.toMatchObject({
        code: 'LLM_UNAVAILABLE',
      });
      expect(posts()).toHaveLength(1);
      await pending({ ...only, taskId: 'task-2' });
      expect(posts()).toHaveLength(2);
    });

    it('an unusable answer is resubmitted by a new task, the same task gets it again', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', 'not json'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', 'not json'))
        .mockResolvedValueOnce(created('batch-2'));

      await pending({ ...only, taskId: 'task-1' });
      await expect(client.chat(request({ ...only, taskId: 'task-1' }))).rejects.toMatchObject({
        code: 'LLM_INVALID_RESPONSE',
      });
      expect(rows.get('call-1')?.batchStatus).toBe('unusable');
      await expect(client.chat(request({ ...only, taskId: 'task-1' }))).rejects.toMatchObject({
        code: 'LLM_INVALID_RESPONSE',
      });
      expect(posts()).toHaveLength(1);
      await pending({ ...only, taskId: 'task-2' });
      expect(posts()).toHaveLength(2);
    });
  });

  describe('модель не идёт батчем', () => {
    it('outside a background task the batch model is skipped for the sync fallback', async () => {
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"s":1}'));

      expect((await client.chat(request({ taskId: null }))).json).toEqual({ s: 1 });
      expect(posts()).toHaveLength(0);
      expect(budget.reserve).toHaveBeenCalledTimes(1);
    });

    it('a batch-only model chosen without the explicit :batch suffix is not sent without deny', async () => {
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"s":2}'));
      const unmarked = { ...batchModel('vendor/odd'), batch: true as const };

      const result = await client.chat(request({ models: [unmarked, syncModel('b/fallback')] }));

      expect(result.json).toEqual({ s: 2 });
      expect(posts()).toHaveLength(0);
      expect(calls().every((c) => c.body?.provider !== undefined)).toBe(true);
    });

    it('a :batch model missing from the catalog (no flag) never goes to /chat/completions: fallback answers', async () => {
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"s":4}'));
      const unknown = syncModel('anthropic/claude-sonnet-5.5:batch');

      const result = await client.chat(request({ models: [unknown, syncModel('b/fallback')] }));

      expect(result.json).toEqual({ s: 4 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(calls()[0].body?.model).toBe('b/fallback');
    });

    it('a sync model refused with 400 still fails the call (only the :batch name is skipped)', async () => {
      fetchSpy.mockResolvedValueOnce(json(400, { error: { code: 400, message: 'bad' } }));

      await expect(
        client.chat(request({ models: [syncModel('a/plain'), syncModel('b/fallback')] })),
      ).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('a batch model priced by the stage cap (no fixed price) is skipped: max_price cannot go into a batch', async () => {
      fetchSpy.mockResolvedValueOnce(syncAnswer('{"s":3}'));
      const capped = { ...batchModel('x/y:batch'), maxPricePerMTok: new Prisma.Decimal(5) };

      expect(
        (await client.chat(request({ models: [capped, syncModel('b/fallback')] }))).json,
      ).toEqual({
        s: 3,
      });
      expect(posts()).toHaveLength(0);
    });
  });

  describe('чистка', () => {
    it('settles a finished batch nobody waits for and only touches open ones', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(created('batch-2'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{}', 0.002))
        .mockResolvedValueOnce(inProgress('batch-2'));

      await pending();
      await pending({ messages: [{ role: 'user', content: 'other' }] });

      expect(await client.pollOpenBatches(new Date(), 20)).toBe(1);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ id: 'call-1', costEstimated: false });
      expect(settled[0].costUsd.toFixed(8)).toBe('0.00200000');
      expect(rows.get('call-2')).toMatchObject({
        batchStatus: 'in_progress',
        reserveReleasedAt: null,
      });
    });

    it('a finished batch without usage.cost closed by housekeeping books the reserve as an estimate', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{}', null));
      await pending();

      expect(await client.pollOpenBatches(new Date(), 20)).toBe(1);
      expect(settled[0]).toMatchObject({ costEstimated: true });
      expect(settled[0].costUsd.toFixed(8)).toBe('0.01000000');
    });

    it('a failing row does not stop the pass', async () => {
      fetchSpy
        .mockResolvedValueOnce(created('batch-1'))
        .mockResolvedValueOnce(created('batch-2'))
        .mockResolvedValueOnce(completed('batch-1', 'call-1', '{}'))
        .mockResolvedValueOnce(completed('batch-2', 'call-2', '{}'));
      await pending();
      await pending({ messages: [{ role: 'user', content: 'other' }] });
      budget.settle.mockRejectedValueOnce(new Error('db down'));

      expect(await client.pollOpenBatches(new Date(), 20)).toBe(1);
    });
  });

  it('batchBaseModel drops only the :batch suffix', () => {
    expect(batchBaseModel('openai/gpt-6-luna:batch')).toBe('openai/gpt-6-luna');
    expect(batchBaseModel('google/gemma-4-31b-it:free')).toBe('google/gemma-4-31b-it:free');
  });
});
