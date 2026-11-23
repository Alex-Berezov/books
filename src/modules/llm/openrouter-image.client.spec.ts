import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { LlmBudgetService, SettleInput } from './llm-budget.service';
import { LlmConfig } from './llm.config';
import {
  IMAGE_BODY_MAX_BYTES,
  LlmImageRequest,
  OpenRouterImageClient,
} from './openrouter-image.client';

const KEY = 'sk-or-test-secret-key-0123456789';
const IMAGE = Buffer.from('fake image bytes').toString('base64');

const ok = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const fail = (status: number) =>
  new Response(JSON.stringify({ error: { code: status, message: 'error' } }), { status });

describe('OpenRouterImageClient (F08-11a)', () => {
  let fetchSpy: jest.SpyInstance;
  let budget: { reserve: jest.Mock; settle: jest.Mock };
  let settled: SettleInput[];
  let client: OpenRouterImageClient;

  const request = (over: Partial<LlmImageRequest> = {}): LlmImageRequest => ({
    operationId: 'op-1',
    stage: 'world_image',
    models: ['a/image', 'b/image'],
    prompt: 'secret appearance text',
    reserveUsd: new Prisma.Decimal('0.25'),
    aspectRatio: '1:1',
    ...over,
  });

  const sentBodies = () =>
    fetchSpy.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
    );

  beforeEach(() => {
    const env: Record<string, string> = { OPENROUTER_API_KEY: KEY, LLM_CALL_TIMEOUT_MS: '50' };
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
    client = new OpenRouterImageClient(config, budget as unknown as LlmBudgetService);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('asks /images for one PNG as base64 under data_collection deny; usage.cost is the fact', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ model: 'a/image', data: [{ b64_json: IMAGE }], usage: { cost: 0.039 } }),
    );
    const result = await client.generate(request());

    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/images$/);
    expect(sentBodies()[0]).toMatchObject({
      model: 'a/image',
      prompt: 'secret appearance text',
      n: 1,
      aspect_ratio: '1:1',
      output_format: 'png',
      response_format: 'b64_json',
      provider: { data_collection: 'deny' },
    });
    expect(result).toMatchObject({ base64: IMAGE, oversize: false, model: 'a/image' });
    expect(result.costUsd.toString()).toBe('0.039');
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledTimes(1);
    expect(budget.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ estimateUsd: new Prisma.Decimal('0.25'), stage: 'world_image' }),
    );
    expect(settled[0]).toMatchObject({ costEstimated: false, actualModel: 'a/image' });
  });

  it('without usage.cost the fact is the reserve, marked as an estimate', async () => {
    fetchSpy.mockResolvedValueOnce(ok({ data: [{ b64_json: IMAGE }] }));
    const result = await client.generate(request());
    expect(result.costUsd.toString()).toBe('0.25');
    expect(settled[0]).toMatchObject({ costEstimated: true });
  });

  it('a 5xx refusal costs nothing and goes to the next model', async () => {
    fetchSpy
      .mockResolvedValueOnce(fail(502))
      .mockResolvedValueOnce(ok({ data: [{ b64_json: IMAGE }], usage: { cost: 0.04 } }));
    const result = await client.generate(request());
    expect(sentBodies().map((b) => b.model)).toEqual(['a/image', 'b/image']);
    expect(settled[0]).toMatchObject({ errorClass: 'http_502', costEstimated: false });
    expect(settled[0].costUsd.toString()).toBe('0');
    expect(result.base64).toBe(IMAGE);
  });

  it('402 stops the call as insufficient funds', async () => {
    fetchSpy.mockResolvedValueOnce(fail(402));
    await expect(client.generate(request())).rejects.toMatchObject({
      code: 'LLM_INSUFFICIENT_FUNDS',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('every model refused - LLM_UNAVAILABLE', async () => {
    fetchSpy.mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(fail(429));
    await expect(client.generate(request())).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });

  it('an answer without an image comes back with base64 null for the caller to refuse', async () => {
    fetchSpy.mockResolvedValueOnce(ok({ data: [], usage: { cost: 0.01 } }));
    await expect(client.generate(request())).resolves.toMatchObject({ base64: null });
  });

  it('a body over the limit is not read into memory: oversize, fact = reserve', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ data: [] }, { 'Content-Length': String(IMAGE_BODY_MAX_BYTES + 1) }),
    );
    const result = await client.generate(request());
    expect(result).toMatchObject({ base64: null, oversize: true });
    expect(settled[0].costUsd.toString()).toBe('0.25');
  });

  it('a streamed body over the limit is cut off while reading', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const result = await client.generate(request());
    expect(result.oversize).toBe(true);
    expect(sent).toBeLessThanOrEqual(IMAGE_BODY_MAX_BYTES + 2 * chunk.byteLength);
  });

  it('a timeout after sending is paid as the reserve, estimated, and goes to the next model', async () => {
    fetchSpy
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce(ok({ data: [{ b64_json: IMAGE }], usage: { cost: 0.04 } }));
    await client.generate(request());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(settled[0]).toMatchObject({ errorClass: 'timeout', costEstimated: true });
    expect(settled[0].costUsd.toString()).toBe('0.25');
  });

  it('a connection that never opened costs nothing and goes to the next model', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    fetchSpy
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(ok({ data: [{ b64_json: IMAGE }], usage: { cost: 0.04 } }));
    await client.generate(request());
    expect(settled[0]).toMatchObject({ errorClass: 'connect', costEstimated: false });
    expect(settled[0].costUsd.toString()).toBe('0');
  });

  it.each([400, 401, 403])(
    'HTTP %s is a refusal of the request: no fallback is called, nothing is paid',
    async (status) => {
      fetchSpy.mockResolvedValueOnce(fail(status));
      await expect(client.generate(request())).rejects.toMatchObject({
        code: 'LLM_PROVIDER_ERROR',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settled[0].costUsd.toString()).toBe('0');
    },
  );

  it('HTTP 404 (no endpoint for the model) goes to the next model', async () => {
    fetchSpy
      .mockResolvedValueOnce(fail(404))
      .mockResolvedValueOnce(ok({ data: [{ b64_json: IMAGE }] }));
    await client.generate(request());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a stop before sending settles zero and refuses LLM_ABORTED without a request', async () => {
    const stop = new AbortController();
    budget.reserve.mockImplementationOnce(() => {
      stop.abort();
      return Promise.resolve({ callId: 'call-1' });
    });
    await expect(client.generate(request({ signal: stop.signal }))).rejects.toMatchObject({
      code: 'LLM_ABORTED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settled[0]).toMatchObject({ errorClass: 'aborted', costEstimated: false });
  });

  it('logs neither the prompt nor the image bytes nor the key', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy
      .mockResolvedValueOnce(fail(500))
      .mockResolvedValueOnce(ok({ data: [{ b64_json: IMAGE }] }));
    await client.generate(request());
    const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain(IMAGE);
    expect(lines).not.toContain('secret appearance text');
    expect(lines).not.toContain(KEY);
  });
});
