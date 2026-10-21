import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmModelsService } from './llm-models.service';
import { LlmConfig } from './llm.config';

const MODELS = {
  data: [
    {
      id: 'a/priced',
      name: 'Priced',
      context_length: 200000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      supported_parameters: ['structured_outputs', 'temperature'],
    },
    { id: 'b/free:free', name: 'Free', pricing: { prompt: '0.5', completion: '0.5' } },
    { id: 'c/dynamic', name: 'Router', pricing: { prompt: '-1', completion: '-1' } },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('LlmModelsService', () => {
  let fetchSpy: jest.SpyInstance;
  let service: LlmModelsService;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchSpy = jest.spyOn(global, 'fetch');
    service = new LlmModelsService(
      new LlmConfig({ get: () => undefined } as unknown as ConfigService),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('parses prices: fixed, :free as zero, dynamic as null; structured outputs by parameters', async () => {
    fetchSpy.mockResolvedValueOnce(json(MODELS));
    const [priced, free, dynamic] = await service.list();

    expect(priced.price.input?.toFixed(8)).toBe('0.00000100');
    expect(priced.structuredOutputs).toBe(true);
    expect(priced.contextLength).toBe(200000);
    expect(free.price.input?.isZero()).toBe(true);
    expect(free.price.output?.isZero()).toBe(true);
    expect(dynamic.price).toEqual({ input: null, output: null });
    expect(dynamic.structuredOutputs).toBe(false);
  });

  it('caches the list for an hour and shares one request between parallel callers', async () => {
    fetchSpy.mockResolvedValue(json(MODELS));
    await Promise.all([service.list(), service.list()]);
    now += 59 * 60 * 1000;
    await service.list();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 2 * 60 * 1000;
    await service.list();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('serves the stale list with a warning when OpenRouter fails after the hour (Р-Е)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy.mockResolvedValueOnce(json(MODELS)).mockResolvedValue(json({}, 500));
    await service.list();
    now += 61 * 60 * 1000;

    const stale = await service.list();
    expect(stale.map((m) => m.id)).toEqual(['a/priced', 'b/free:free', 'c/dynamic']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale'));
    expect(warn).toHaveBeenCalledTimes(1);
    // Минуту после сбоя наружу не ходим - устаревший список без ожидания таймаута.
    await service.list();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Время кэша не сдвинуто: через минуту снова идём наружу.
    now += 61 * 1000;
    await service.list();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('without any cached list a failure is 503 LLM_MODELS_UNAVAILABLE', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(service.list()).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'LLM_MODELS_UNAVAILABLE' }) as unknown,
    });
  });

  it('a 200 without a model list is a failure, not an empty catalog for an hour', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy.mockResolvedValueOnce(json(MODELS)).mockResolvedValueOnce(json({ data: null }));
    await service.list();
    now += 61 * 60 * 1000;
    const stale = await service.list();
    expect(stale).toHaveLength(3);
  });

  it('without any list, a minute after a failure answers 503 without going out again', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.list()).rejects.toMatchObject({ status: 503 });
    await expect(service.list()).rejects.toMatchObject({ status: 503 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    now += 61 * 1000;
    await expect(service.list()).rejects.toMatchObject({ status: 503 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
