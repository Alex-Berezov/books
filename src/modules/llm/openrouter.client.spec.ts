import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { LlmBudgetService, SettleInput } from './llm-budget.service';
import { LlmConfig } from './llm.config';
import { LlmBudgetExceededError } from './llm.errors';
import { LlmCallModel, LlmChatRequest, OpenRouterClient } from './openrouter.client';

const KEY = 'sk-or-test-secret-key-0123456789';

const model = (id: string): LlmCallModel => ({
  id,
  inputPrice: new Prisma.Decimal('0.000001'),
  outputPrice: new Prisma.Decimal('0.000002'),
  structuredOutputs: true,
});

const ok = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const fail = (status: number, message = 'error') =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status });

const success = (cost?: number) =>
  ok({
    model: 'a/primary',
    provider: 'SomeProvider',
    choices: [{ message: { content: '{"answer":42}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, ...(cost !== undefined && { cost }) },
  });

describe('OpenRouterClient', () => {
  let fetchSpy: jest.SpyInstance;
  let budget: { reserve: jest.Mock; settle: jest.Mock };
  let settled: SettleInput[];
  let client: OpenRouterClient;
  let env: Record<string, string | undefined>;

  const request = (over: Partial<LlmChatRequest> = {}): LlmChatRequest => ({
    operationId: 'op-1',
    stage: 'test_stage',
    models: [model('a/primary'), model('b/fallback')],
    messages: [{ role: 'user', content: 'secret book text' }],
    temperature: 0.2,
    maxTokens: 1000,
    ...over,
  });

  const sentBodies = () =>
    fetchSpy.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
    );

  beforeEach(() => {
    env = { OPENROUTER_API_KEY: KEY, LLM_CALL_TIMEOUT_MS: '50' };
    const config = new LlmConfig({ get: (k: string) => env[k] } as unknown as ConfigService);
    settled = [];
    let n = 0;
    budget = {
      reserve: jest.fn(() => Promise.resolve({ callId: `call-${++n}` })),
      settle: jest.fn((_id: string, input: SettleInput) => {
        settled.push(input);
        return Promise.resolve(true);
      }),
    };
    client = new OpenRouterClient(config, budget as unknown as LlmBudgetService);
    jest.spyOn(client as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns parsed JSON and takes usage.cost as the fact', async () => {
    fetchSpy.mockResolvedValueOnce(success(0.0123));
    const result = await client.chat(request({ jsonSchema: { name: 'a', schema: {} } }));

    expect(result.json).toEqual({ answer: 42 });
    expect(result.provider).toBe('SomeProvider');
    expect(result.costUsd.toFixed(8)).toBe('0.01230000');
    expect(settled).toHaveLength(1);
    expect(settled[0].costUsd.toFixed(8)).toBe('0.01230000');
    expect(settled[0].costEstimated).toBe(false);
    // Резерв: 1000 × 0.000002 за выход + оценка входа × 0.000001.
    const estimate = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
      .estimateUsd;
    expect(estimate.greaterThanOrEqualTo('0.002')).toBe(true);
  });

  it('always sends data_collection: deny and usage include (Р7)', async () => {
    fetchSpy.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(success(0));
    await client.chat(request());

    for (const body of sentBodies()) {
      expect(body.provider).toEqual({ data_collection: 'deny' });
      expect(body.usage).toEqual({ include: true });
    }
  });

  it('429 moves to the fallback model', async () => {
    fetchSpy.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(success(0));
    await client.chat(request());

    expect(sentBodies().map((b) => b.model)).toEqual(['a/primary', 'b/fallback']);
    expect(settled[0].costUsd.isZero()).toBe(true);
  });

  it('"no compliant provider" goes to the fallback without retrying the same model', async () => {
    fetchSpy
      .mockResolvedValueOnce(fail(404, 'No endpoints found matching your data policy'))
      .mockResolvedValueOnce(success(0));
    await client.chat(request());

    expect(sentBodies().map((b) => b.model)).toEqual(['a/primary', 'b/fallback']);
  });

  it('runs out of compliant providers with LLM_NO_COMPLIANT_PROVIDER naming the models', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(fail(404, 'No endpoints found matching your data policy')),
    );
    await expect(client.chat(request())).rejects.toMatchObject({
      code: 'LLM_NO_COMPLIANT_PROVIDER',
      message: expect.stringContaining('a/primary, b/fallback') as unknown,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('402 is LLM_INSUFFICIENT_FUNDS without retries', async () => {
    fetchSpy.mockResolvedValue(fail(402));
    await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_INSUFFICIENT_FUNDS' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a timeout aborts the call and books fact = reserve as an estimate', async () => {
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    });
    await expect(client.chat(request({ models: [model('a/primary')] }))).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const reserve = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
      .estimateUsd;
    expect(settled[0].errorClass).toBe('timeout');
    expect(settled[0].costEstimated).toBe(true);
    expect(settled[0].costUsd.equals(reserve)).toBe(true);
  });

  it('invalid JSON is a content error, booked with its real cost', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        model: 'a/primary',
        choices: [{ message: { content: 'not json' } }],
        usage: { cost: 0.5 },
      }),
    );
    await expect(
      client.chat(request({ jsonSchema: { name: 'a', schema: {} } })),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(settled[0].costUsd.toFixed(2)).toBe('0.50');
  });

  it('JSON wrapped whole in a ```json fence is parsed; text around JSON is still not JSON (Р1 F05-R)', async () => {
    const answer = (content: string) =>
      ok({ model: 'a/primary', choices: [{ message: { content } }], usage: { cost: 0.1 } });
    fetchSpy
      .mockResolvedValueOnce(answer('```json\n{"answer":42}\n```'))
      .mockResolvedValueOnce(answer('```JSON\n{"answer":42}```'))
      .mockResolvedValueOnce(answer('Here it is:\n```json\n{"answer":42}\n```'));
    const schema = { name: 'a', schema: {}, textOnly: true };
    // Тег ограды в любом регистре, закрывающая ограда - и вплотную к JSON.
    for (let i = 0; i < 2; i++) {
      await expect(client.chat(request({ jsonSchema: schema }))).resolves.toMatchObject({
        json: { answer: 42 },
      });
    }
    await expect(client.chat(request({ jsonSchema: schema }))).rejects.toMatchObject({
      code: 'LLM_INVALID_RESPONSE',
    });
  });

  it('calls beforeAttempt before every attempt; its failure stops the call', async () => {
    const beforeAttempt = jest.fn();
    fetchSpy.mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(success(0));
    await client.chat(request({ beforeAttempt }));
    expect(beforeAttempt).toHaveBeenCalledTimes(2);

    fetchSpy.mockClear();
    const lost = jest.fn().mockRejectedValue(new Error('lease lost'));
    await expect(client.chat(request({ beforeAttempt: lost }))).rejects.toThrow('lease lost');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('without a key refuses with 503 LLM_DISABLED and never calls out', async () => {
    env.OPENROUTER_API_KEY = '';
    await expect(client.chat(request())).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'LLM_DISABLED' }) as unknown,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('keeps the key and the text out of logs and the call journal', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy.mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(success(0));
    await client.chat(request());

    const logged = JSON.stringify([warn.mock.calls, budget.reserve.mock.calls, settled]);
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('secret book text');
    // Ключ уходит только в заголовок запроса.
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  describe('fact without usage.cost', () => {
    it('tokens × the price of this attempt, marked as an estimate', async () => {
      fetchSpy.mockResolvedValueOnce(success());
      const result = await client.chat(request());
      // 100 × 0.000001 + 50 × 0.000002
      expect(result.costUsd.toFixed(8)).toBe('0.00020000');
      expect(settled[0]).toMatchObject({ costEstimated: true, inputTokens: 100, outputTokens: 50 });
    });

    it('no cost and no tokens: fact = reserve, marked as an estimate', async () => {
      fetchSpy.mockResolvedValueOnce(
        ok({ model: 'a/primary', choices: [{ message: { content: 'x' } }] }),
      );
      await client.chat(request());
      const reserve = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
        .estimateUsd;
      expect(settled[0].costUsd.equals(reserve)).toBe(true);
      expect(settled[0].costEstimated).toBe(true);
    });
  });

  it('reserves input at a token per character (Р-Д)', async () => {
    fetchSpy.mockResolvedValueOnce(success(0));
    await client.chat(
      request({ messages: [{ role: 'user', content: 'x'.repeat(1000) }], maxTokens: 0 }),
    );
    const estimate = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
      .estimateUsd;
    // (1000 + 16) × 0.000001
    expect(estimate.toFixed(8)).toBe('0.00101600');
  });

  it('a model priced by the stage cap reserves the service input of a router too (Р6 F05-R)', async () => {
    fetchSpy.mockResolvedValueOnce(success(0)).mockResolvedValueOnce(success(0));
    const messages = [{ role: 'user' as const, content: 'x'.repeat(1000) }];
    const capped: LlmCallModel = {
      ...model('c/dynamic'),
      inputPrice: new Prisma.Decimal('0.000005'),
      outputPrice: new Prisma.Decimal('0.000005'),
      maxPricePerMTok: new Prisma.Decimal('5'),
    };
    await client.chat(request({ messages, maxTokens: 0, models: [capped] }));
    await client.chat(request({ messages, maxTokens: 0, models: [model('a/primary')] }));
    const [router, priced] = budget.reserve.mock.calls.map(
      (c) => (c[0] as { estimateUsd: Prisma.Decimal }).estimateUsd,
    );
    // (1000 + 16 + 1000 служебных) × 0.000005; у модели с ценой каталога надбавки нет.
    expect(router.toFixed(8)).toBe('0.01008000');
    expect(priced.toFixed(8)).toBe('0.00101600');
  });

  it('a 200 with an error body is handled by its code (429 -> fallback)', async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ error: { code: 429, message: 'rate limited' } }))
      .mockResolvedValueOnce(success(0));
    await client.chat(request());
    expect(sentBodies().map((b) => b.model)).toEqual(['a/primary', 'b/fallback']);
  });

  it('three 5xx on the primary, then the fallback', async () => {
    fetchSpy
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(fail(502))
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValueOnce(success(0));
    await client.chat(request());
    expect(sentBodies().map((b) => b.model)).toEqual([
      'a/primary',
      'a/primary',
      'a/primary',
      'b/fallback',
    ]);
  });

  it('429 on the last model is retried, not dropped', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(fail(429)));
    await expect(client.chat(request({ models: [model('a/primary')] }))).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('a budget refusal stops the call without trying fallbacks (Р-Г)', async () => {
    budget.reserve.mockRejectedValueOnce(new LlmBudgetExceededError('operation'));
    await expect(client.chat(request())).rejects.toMatchObject({ level: 'operation' });
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('network failures (Р-Б)', () => {
    const connectError = (code: string) =>
      Object.assign(new TypeError('fetch failed'), { cause: { code } });

    it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
      '%s before connecting books 0',
      async (code) => {
        fetchSpy.mockRejectedValueOnce(connectError(code)).mockResolvedValueOnce(success(0));
        await client.chat(request());
        expect(settled[0]).toMatchObject({ errorClass: 'connect', costEstimated: false });
        expect(settled[0].costUsd.isZero()).toBe(true);
      },
    );

    it('an unknown code books the reserve', async () => {
      fetchSpy.mockRejectedValueOnce(connectError('ECONNRESET')).mockResolvedValueOnce(success(0));
      await client.chat(request());
      const reserve = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
        .estimateUsd;
      expect(settled[0]).toMatchObject({ errorClass: 'network', costEstimated: true });
      expect(settled[0].costUsd.equals(reserve)).toBe(true);
    });

    it('a 200 with a broken body is a network retry booked at the reserve', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('{"choices": [', { status: 200 }))
        .mockResolvedValueOnce(success(0));
      await client.chat(request());
      expect(settled[0]).toMatchObject({ errorClass: 'body_read', costEstimated: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('request body', () => {
    it('response_format only for a model that accepts a JSON schema', async () => {
      fetchSpy.mockResolvedValueOnce(success(0)).mockResolvedValueOnce(success(0));
      const schema = { name: 's', schema: { type: 'object' } };
      await client.chat(request({ jsonSchema: schema }));
      await client.chat(
        request({
          jsonSchema: schema,
          models: [{ ...model('a/plain'), structuredOutputs: false }],
        }),
      );
      const [withSchema, without] = sentBodies();
      expect(withSchema.response_format).toMatchObject({ type: 'json_schema' });
      expect(without).not.toHaveProperty('response_format');
    });

    it('a text-only schema is not sent as response_format even to a structured model', async () => {
      fetchSpy.mockResolvedValueOnce(success(0));
      await client.chat(
        request({ jsonSchema: { name: 's', schema: { type: 'object' }, textOnly: true } }),
      );
      expect(sentBodies()[0]).not.toHaveProperty('response_format');
    });

    it('temperature null is not sent', async () => {
      fetchSpy.mockResolvedValueOnce(success(0));
      await client.chat(request({ temperature: null }));
      expect(sentBodies()[0]).not.toHaveProperty('temperature');
    });

    it('max_price goes to the provider only for a model priced by the stage cap (Р-В)', async () => {
      fetchSpy.mockResolvedValueOnce(success(0)).mockResolvedValueOnce(success(0));
      const capped: LlmCallModel = {
        ...model('c/dynamic'),
        maxPricePerMTok: new Prisma.Decimal('5'),
      };
      await client.chat(request({ models: [capped] }));
      await client.chat(request({ models: [model('a/primary')] }));
      const [cappedBody, fixedBody] = sentBodies();
      expect(cappedBody.provider).toEqual({
        data_collection: 'deny',
        max_price: { prompt: 5, completion: 5 },
      });
      expect(fixedBody.provider).toEqual({ data_collection: 'deny' });
    });
  });

  describe('refusals without retries', () => {
    it('402 releases the reserve with fact 0', async () => {
      fetchSpy.mockResolvedValue(fail(402));
      await expect(client.chat(request())).rejects.toMatchObject({
        code: 'LLM_INSUFFICIENT_FUNDS',
      });
      expect(budget.settle).toHaveBeenCalledTimes(1);
      expect(settled[0]).toMatchObject({ errorClass: 'http_402', costEstimated: false });
      expect(settled[0].costUsd.isZero()).toBe(true);
    });

    it.each([400, 401, 403])(
      '%i is LLM_PROVIDER_ERROR without a retry or a fallback',
      async (status) => {
        fetchSpy.mockResolvedValue(fail(status));
        await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(settled[0].costUsd.isZero()).toBe(true);
      },
    );

    it('408 is retried', async () => {
      fetchSpy.mockResolvedValueOnce(fail(408)).mockResolvedValueOnce(success(0));
      await client.chat(request());
      expect(sentBodies().map((b) => b.model)).toEqual(['a/primary', 'a/primary']);
    });

    it('a 200 without content is a content error, booked with its cost', async () => {
      fetchSpy.mockResolvedValueOnce(
        ok({ model: 'a/primary', choices: [], usage: { cost: 0.01 } }),
      );
      await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settled[0].costUsd.toFixed(2)).toBe('0.01');
    });
  });

  describe('round 2', () => {
    it('an error inside a 200 body without cost books the reserve: tokens may be billed', async () => {
      fetchSpy
        .mockResolvedValueOnce(ok({ error: { code: 502, message: 'provider failed' } }))
        .mockResolvedValueOnce(success(0));
      await client.chat(request());
      const reserve = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
        .estimateUsd;
      expect(settled[0]).toMatchObject({ errorClass: 'http_502', costEstimated: true });
      expect(settled[0].costUsd.equals(reserve)).toBe(true);
    });

    it('404 "no endpoints" for another reason moves on but is not a data-policy refusal', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(fail(404, 'No endpoints found matching your max price')),
      );
      await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
      expect(sentBodies().map((b) => b.model)).toEqual(['a/primary', 'b/fallback']);
    });

    it('a body that cannot be serialised fails before any reserve', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(
        client.chat(request({ jsonSchema: { name: 'c', schema: circular } })),
      ).rejects.toThrow(TypeError);
      expect(budget.reserve).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('round 3', () => {
    it('a request that cannot be built books 0 and is not retried', async () => {
      fetchSpy.mockRejectedValue(new TypeError('Failed to parse URL from openrouter.ai/api/v1'));
      await expect(client.chat(request())).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ errorClass: 'local', costEstimated: false });
      expect(settled[0].costUsd.isZero()).toBe(true);
    });

    it('the JSON schema counts towards the input estimate', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(success(0)));
      const schema = { type: 'object', description: 'x'.repeat(5000) };
      await client.chat(request({ maxTokens: 0 }));
      await client.chat(request({ maxTokens: 0, jsonSchema: { name: 's', schema } }));
      const [plain, withSchema] = budget.reserve.mock.calls.map(
        ([arg]) => (arg as { estimateUsd: Prisma.Decimal }).estimateUsd,
      );
      expect(withSchema.minus(plain).toFixed(8)).toBe(
        new Prisma.Decimal(JSON.stringify(schema).length).mul('0.000001').toFixed(8),
      );
    });

    it('numbers attempts across retries and fallbacks and settles each on its own call', async () => {
      fetchSpy
        .mockResolvedValueOnce(fail(500))
        .mockResolvedValueOnce(fail(429))
        .mockResolvedValueOnce(success(0));
      await client.chat(request());
      expect(
        budget.reserve.mock.calls.map(([arg]) => {
          const { attempt, requestedModel, operationId, stage } = arg as Record<string, unknown>;
          return [attempt, requestedModel, operationId, stage];
        }),
      ).toEqual([
        [1, 'a/primary', 'op-1', 'test_stage'],
        [2, 'a/primary', 'op-1', 'test_stage'],
        [3, 'b/fallback', 'op-1', 'test_stage'],
      ]);
      expect(budget.settle.mock.calls.map(([callId]) => callId as string)).toEqual([
        'call-1',
        'call-2',
        'call-3',
      ]);
    });
  });

  describe('external abort (F05-1w, Р-Б)', () => {
    const hangUntilAbort = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });

    it('an abort after sending books the reserve, is not a timeout and is not retried', async () => {
      const controller = new AbortController();
      env.LLM_CALL_TIMEOUT_MS = '60000';
      fetchSpy.mockImplementation((url: string, init: RequestInit) => {
        setTimeout(() => controller.abort(), 5);
        return hangUntilAbort(url, init);
      });

      await expect(client.chat(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const reserve = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
        .estimateUsd;
      expect(settled).toHaveLength(1);
      expect(settled[0].errorClass).toBe('aborted');
      expect(settled[0].costEstimated).toBe(true);
      expect(settled[0].costUsd.equals(reserve)).toBe(true);
    });

    it('an abort before the attempt reserves nothing and sends nothing', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(client.chat(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      expect(budget.reserve).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('an abort between the reserve and sending books fact 0', async () => {
      const controller = new AbortController();
      budget.reserve.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve({ callId: 'call-x' });
      });
      await expect(client.chat(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(settled).toHaveLength(1);
      expect(settled[0].costUsd.isZero()).toBe(true);
      expect(settled[0].costEstimated).toBe(false);
    });

    it('an abort during the backoff stops before the next attempt', async () => {
      const controller = new AbortController();
      const sleep = jest
        .spyOn(
          client as unknown as { sleep: (ms: number, s?: AbortSignal) => Promise<void> },
          'sleep',
        )
        .mockImplementation((_ms, signal) => {
          // Пауза получает сигнал вызова - иначе остановка ждала бы её до конца.
          expect(signal).toBe(controller.signal);
          controller.abort();
          return Promise.resolve();
        });
      fetchSpy.mockResolvedValue(fail(500));
      await expect(client.chat(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('the backoff sleep itself wakes up on abort', async () => {
      const real = new OpenRouterClient(
        new LlmConfig({ get: () => undefined } as unknown as ConfigService),
        budget as unknown as LlmBudgetService,
      ) as unknown as { sleep: (ms: number, signal?: AbortSignal) => Promise<void> };
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 5);
      await real.sleep(60_000, controller.signal);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('writes the task id into the reserve', async () => {
      fetchSpy.mockResolvedValueOnce(success(0.01));
      await client.chat(request({ taskId: 'task-7' }));
      expect(budget.reserve).toHaveBeenCalledTimes(1);
      expect((budget.reserve.mock.calls[0][0] as { taskId: string }).taskId).toBe('task-7');
    });

    // Тело, которое читается до прерывания: `res.json()` с внешним сигналом рвётся на чтении.
    const bodyCutByAbort = (status: number, controller: AbortController) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: () => {
          controller.abort();
          return Promise.reject(new SyntaxError('Unexpected end of JSON input'));
        },
      }) as unknown as Response;

    it('an abort while reading a 200 body books the reserve: generation may have run', async () => {
      const controller = new AbortController();
      fetchSpy.mockResolvedValueOnce(bodyCutByAbort(200, controller));
      await expect(client.chat(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      const reserve = (budget.reserve.mock.calls[0][0] as { estimateUsd: Prisma.Decimal })
        .estimateUsd;
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ errorClass: 'aborted', costEstimated: true });
      expect(settled[0].costUsd.equals(reserve)).toBe(true);
    });

    it('an abort while reading an HTTP error body books fact 0: rejected before generation', async () => {
      const controller = new AbortController();
      fetchSpy.mockResolvedValueOnce(bodyCutByAbort(500, controller));
      await expect(client.chat(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'LLM_ABORTED',
      });
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ errorClass: 'aborted', costEstimated: false });
      expect(settled[0].costUsd.isZero()).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
