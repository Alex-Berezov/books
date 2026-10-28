import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmStageSetting, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmBudgetService } from './llm-budget.service';
import { LlmModelInfo, LlmModelsService } from './llm-models.service';
import { LlmStageRegistry } from './llm-stages.registry';
import { LlmConfig } from './llm.config';
import { LlmService } from './llm.service';
import { LlmCallModel, OpenRouterClient, SUMMARY_INPUT_CHARS_PER_TOKEN } from './openrouter.client';

const D = (v: string | number) => new Prisma.Decimal(v);

const MODELS: LlmModelInfo[] = [
  {
    id: 'a/priced',
    name: 'Priced',
    contextLength: null,
    price: { input: D('0.000001'), output: D('0.000002') },
    structuredOutputs: true,
  },
  {
    id: 'b/second',
    name: 'Second',
    contextLength: null,
    price: { input: D(0), output: D(0) },
    structuredOutputs: false,
  },
  {
    id: 'c/dynamic',
    name: 'Router',
    contextLength: null,
    price: { input: null, output: null },
    structuredOutputs: false,
  },
];

const row = (over: Partial<LlmStageSetting>): LlmStageSetting => ({
  id: 'row',
  stage: 'jev',
  model: 'a/priced',
  fallbacks: [],
  temperature: null,
  maxTokens: null,
  enabled: true,
  maxPricePerMTok: null,
  updatedAt: new Date('2026-10-21T00:00:00Z'),
  updatedById: null,
  ...over,
});

describe('LlmService', () => {
  let key: string;
  let prisma: {
    llmStageSetting: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock };
    llmOperation: { create: jest.Mock };
  };
  let budget: { getBudget: jest.Mock; updateBudget: jest.Mock };
  let client: { chat: jest.Mock };
  let models: { list: jest.Mock };
  let service: LlmService;

  beforeEach(() => {
    key = 'sk-test';
    prisma = {
      llmStageSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn((args: { create: Partial<LlmStageSetting> }) =>
          Promise.resolve(row(args.create)),
        ),
      },
      llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op' }) },
    };
    budget = { getBudget: jest.fn().mockResolvedValue(null), updateBudget: jest.fn() };
    client = { chat: jest.fn().mockResolvedValue({}) };
    models = { list: jest.fn().mockResolvedValue(MODELS) };
    const registry = new LlmStageRegistry();
    registry.register({
      stage: 'on',
      model: 'a/priced',
      fallbacks: [],
      temperature: null,
      maxTokens: 100,
      enabled: true,
    });
    // Выключенный по умолчанию этап с температурой - как будущий `check_language_jev`.
    registry.register({
      stage: 'jev',
      model: 'a/priced',
      fallbacks: [],
      temperature: 0.3,
      maxTokens: 100,
      enabled: false,
    });
    // Проверяющий этап с резервом ответа - как `check_semantic` (`LEGACY-478`).
    registry.register({
      stage: 'checker',
      model: 'a/priced',
      fallbacks: [],
      temperature: 0,
      maxTokens: 6_000,
      enabled: true,
      reasoningAnswerReserve: 4_000,
      callTimeoutMs: 420_000,
    });
    service = new LlmService(
      prisma as unknown as PrismaService,
      new LlmConfig({ get: () => key } as unknown as ConfigService),
      registry,
      models as unknown as LlmModelsService,
      budget as unknown as LlmBudgetService,
      client as unknown as OpenRouterClient,
    );
  });

  it('status answers without the ceiling row instead of failing (В4)', async () => {
    key = '';
    await expect(service.status()).resolves.toEqual({
      state: 'DISABLED',
      keyConfigured: false,
      budgetConfigured: false,
      ceilingUsd: null,
      spentUsd: null,
      reservedUsd: null,
      defaultRunLimitUsd: null,
    });
  });

  describe('callStage', () => {
    const call = () => service.callStage('op', 'jev', [{ role: 'user', content: 'x' }]);

    it('a disabled stage is refused without calling the model', async () => {
      await expect(call()).rejects.toMatchObject({ code: 'LLM_STAGE_DISABLED' });
      expect(client.chat).not.toHaveBeenCalled();
    });

    it('a model without a price and without a stage cap is refused (Р24)', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({ model: 'c/dynamic' }));
      await expect(call()).rejects.toMatchObject({ code: 'LLM_NO_PRICE' });
      expect(client.chat).not.toHaveBeenCalled();
    });

    it('a model without a price is priced by the stage cap, and the cap travels with it (Р-В)', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ model: 'c/dynamic', maxPricePerMTok: D('5') }),
      );
      await call();
      const [model] = (client.chat.mock.calls[0][0] as { models: LlmCallModel[] }).models;
      expect(model.inputPrice.toFixed(8)).toBe('0.00000500');
      expect(model.outputPrice.toFixed(8)).toBe('0.00000500');
      expect(model.maxPricePerMTok?.toFixed(2)).toBe('5.00');
    });

    it('passes the worker options through to the client: lease renewal, signal, task id', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({}));
      const beforeAttempt = jest.fn();
      const signal = new AbortController().signal;
      await service.callStage('op', 'jev', [{ role: 'user', content: 'x' }], {
        beforeAttempt,
        signal,
        taskId: 'task-1',
      });
      expect(client.chat).toHaveBeenCalledTimes(1);
      const sent = client.chat.mock.calls[0][0] as {
        beforeAttempt: unknown;
        signal: unknown;
        taskId: unknown;
      };
      expect(sent.beforeAttempt).toBe(beforeAttempt);
      expect(sent.signal).toBe(signal);
      expect(sent.taskId).toBe('task-1');
    });

    // Потолок рассуждений проверяющих (`LEGACY-478`, решение арбитра `F05 | F05-13`).
    describe('reasoning ceiling', () => {
      const callOf = (stage: string) =>
        service.callStage('op', stage, [{ role: 'user', content: 'x' }]);
      const sentCeiling = () =>
        (client.chat.mock.calls[0][0] as { reasoningMaxTokens?: number }).reasoningMaxTokens;

      it('a stage with an answer reserve sends maxTokens minus the reserve', async () => {
        await callOf('checker');
        expect(client.chat).toHaveBeenCalledTimes(1);
        expect(sentCeiling()).toBe(2_000);
      });

      it('a stage without a reserve sends no ceiling', async () => {
        await callOf('on');
        expect(client.chat).toHaveBeenCalledTimes(1);
        expect(sentCeiling()).toBeUndefined();
      });

      it('a row lowering maxTokens lowers the ceiling, not below 1024; at or below the reserve there is none', async () => {
        for (const maxTokens of [16_000, 5_024, 5_023, 4_001, 4_000]) {
          prisma.llmStageSetting.findUnique.mockResolvedValueOnce(
            row({ stage: 'checker', maxTokens, enabled: true }),
          );
          await callOf('checker');
        }
        expect(client.chat).toHaveBeenCalledTimes(5);
        const sent = client.chat.mock.calls.map(
          (c) => (c[0] as { reasoningMaxTokens?: number }).reasoningMaxTokens,
        );
        expect(sent).toEqual([12_000, 1_024, 1_024, 1_024, undefined]);
      });
    });

    // Таймаут по этапу (`LEGACY-479`, решение арбитра `F05 | F05-13c`): только в коде, строка
    // настроек его не перекрывает.
    describe('stage call timeout', () => {
      const sentTimeout = () =>
        (client.chat.mock.calls[0][0] as { callTimeoutMs?: number }).callTimeoutMs;

      it('a stage with its own timeout sends it, also over a saved row', async () => {
        prisma.llmStageSetting.findUnique.mockResolvedValueOnce(
          row({ stage: 'checker', maxTokens: 16_000, enabled: true }),
        );
        await service.callStage('op', 'checker', [{ role: 'user', content: 'x' }]);
        expect(client.chat).toHaveBeenCalledTimes(1);
        expect(sentTimeout()).toBe(420_000);
      });

      it('a stage with its own timeout and no saved row sends it from the definition', async () => {
        prisma.llmStageSetting.findUnique.mockResolvedValueOnce(null);
        await service.callStage('op', 'checker', [{ role: 'user', content: 'x' }]);
        expect(client.chat).toHaveBeenCalledTimes(1);
        expect(sentTimeout()).toBe(420_000);
      });

      it('a stage without one sends none - the common timeout applies', async () => {
        await service.callStage('op', 'on', [{ role: 'user', content: 'x' }]);
        expect(client.chat).toHaveBeenCalledTimes(1);
        expect(sentTimeout()).toBeUndefined();
      });
    });

    it('a row without temperature keeps the stage default', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({ temperature: null }));
      await call();
      expect(client.chat.mock.calls[0][0]).toMatchObject({ temperature: 0.3, maxTokens: 100 });
    });

    // Сравнение (`F05-3`, С7): колонка модели - текст ровно этой модели, запасные этапа не идут.
    it('options.model calls only that model, without the stage fallbacks', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ model: 'a/priced', fallbacks: ['b/second'] }),
      );
      await service.callStage('op', 'jev', [{ role: 'user', content: 'x' }], {
        model: 'b/second',
      });
      const sent = client.chat.mock.calls[0][0] as { models: LlmCallModel[]; temperature: unknown };
      expect(sent.models.map((m) => m.id)).toEqual(['b/second']);
      expect(sent.temperature).toBe(0.3);
    });

    // Снимок запуска (`F05-4a`, В1): модель и запасные снимка, а не этапа; запасная без цены
    // пропускается, и `stageCallModels` называет ровно те модели, что ушли в вызов.
    it('options.model with fallbacks calls them in order, skips an unpriced one, and names the same models', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ model: 'c/dynamic', fallbacks: ['a/stage-fallback'] }),
      );
      const options = { model: 'a/priced', fallbacks: ['c/dynamic', 'b/second'] };
      await service.callStage('op', 'jev', [{ role: 'user', content: 'x' }], options);
      const sent = client.chat.mock.calls[0][0] as { models: LlmCallModel[] };
      expect(sent.models.map((m) => m.id)).toEqual(['a/priced', 'b/second']);
      expect(await service.stageCallModels('jev', options)).toEqual(['a/priced', 'b/second']);
    });

    it('stageFit with a model and fallbacks fits by the smallest context of them', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({ fallbacks: [] }));
      models.list.mockResolvedValue(
        MODELS.map((m) => (m.id === 'b/second' ? { ...m, contextLength: 10 } : m)),
      );
      const request = { messages: [{ role: 'user' as const, content: 'x' }] };
      expect((await service.stageFit('jev', request, 'a/priced')).fits).toBe(true);
      expect((await service.stageFit('jev', request, 'a/priced', ['b/second'])).fits).toBe(false);
      // Запасная без цены в вызов не уйдёт - её контекст куску не отказывает.
      models.list.mockResolvedValue(
        MODELS.map((m) => (m.id === 'c/dynamic' ? { ...m, contextLength: 10 } : m)),
      );
      expect((await service.stageFit('jev', request, 'a/priced', ['c/dynamic'])).fits).toBe(true);
    });

    it('options.model without a price and without a stage cap is refused', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({}));
      await expect(
        service.callStage('op', 'jev', [{ role: 'user', content: 'x' }], { model: 'c/dynamic' }),
      ).rejects.toMatchObject({ code: 'LLM_NO_PRICE' });
      expect(client.chat).not.toHaveBeenCalled();
    });

    it('stageCallEstimator with a model prices that model and takes only its context', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({ stage: 'on', fallbacks: [] }));
      models.list.mockResolvedValue(
        MODELS.map((m) => (m.id === 'b/second' ? { ...m, contextLength: 1000 } : m)),
      );
      const call = await service.stageCallEstimator('on', 'b/second');
      expect(call.contextLength).toBe(1000);
      // `b/second` бесплатна: оценка - ноль, а не цена основной модели этапа.
      expect(call.estimate({ messages: [{ role: 'user', content: 'x' }] }).toFixed(8)).toBe(
        '0.00000000',
      );
    });

    it('stageCallEstimator of a model priced by the cap adds the service input of a router, as the reserve does (Р6 F05-R)', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ model: 'c/dynamic', maxPricePerMTok: D('5') }),
      );
      const request = { messages: [{ role: 'user' as const, content: 'x'.repeat(100) }] };
      const router = await service.stageCallEstimator('jev');
      // (100 + 16 + 1000 служебных) × 5 / 1M + maxTokens × 5 / 1M.
      expect(router.estimate(request).toFixed(8)).toBe(
        D(1116 + router.maxTokens)
          .mul('0.000005')
          .toFixed(8),
      );
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({}));
      const priced = await service.stageCallEstimator('jev');
      expect(priced.estimate(request).toFixed(8)).toBe(
        D(116).mul('0.000001').add(D(priced.maxTokens).mul('0.000002')).toFixed(8),
      );
    });

    it('operationData puts the prices of the compared models into the snapshot', async () => {
      const data = await service.operationData({
        kind: 'compare',
        limitUsd: D(1),
        models: ['b/second'],
      });
      const snapshot = data.settingsSnapshot as { prices: Array<{ id: string }> };
      expect(snapshot.prices.map((p) => p.id)).toContain('b/second');
    });
  });

  describe('updateStageSetting', () => {
    it('a zero price cap is 400: it would reserve nothing', async () => {
      await expect(
        service.updateStageSetting('jev', { model: 'c/dynamic', maxPricePerMTok: '0' }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.llmStageSetting.upsert).not.toHaveBeenCalled();
    });

    it('fallbacks repeating the model or each other are 400', async () => {
      for (const fallbacks of [['a/priced'], ['b/second', 'b/second']]) {
        await expect(
          service.updateStageSetting('jev', { model: 'a/priced', fallbacks }, null),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(prisma.llmStageSetting.upsert).not.toHaveBeenCalled();
    });

    it('omitted enabled keeps the registry default: changing the model does not switch a stage on', async () => {
      const res = await service.updateStageSetting('jev', { model: 'b/second' }, 'admin');
      const data = (prisma.llmStageSetting.upsert.mock.calls[0][0] as { create: LlmStageSetting })
        .create;
      expect(data.enabled).toBe(false);
      expect(res).toMatchObject({ model: 'b/second', enabled: false, temperature: 0.3 });
    });

    it('an unknown stage is 404', async () => {
      await expect(
        service.updateStageSetting('nope', { model: 'a/priced' }, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('budget', () => {
    it('a partial PUT passes only the given field', async () => {
      budget.updateBudget.mockResolvedValue({
        ceilingUsd: D(100),
        spentUsd: D(0),
        reservedUsd: D(0),
        defaultRunLimitUsd: D(25),
        updatedAt: new Date(),
      });
      await service.updateBudget({ defaultRunLimitUsd: '25' }, null);
      const patch = budget.updateBudget.mock.calls[0][0] as Record<string, Prisma.Decimal>;
      expect(Object.keys(patch)).toEqual(['defaultRunLimitUsd']);
    });

    it('without the ceiling row PUT is 404 and nothing is created', async () => {
      budget.updateBudget.mockResolvedValue(null);
      await expect(service.updateBudget({ ceilingUsd: '1' }, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('createOperation: an explicit limit wins; without the ceiling row the default is 0', async () => {
      await service.createOperation({ kind: 'compare', limitUsd: D('3') });
      await service.createOperation({ kind: 'compare' });
      const limits = prisma.llmOperation.create.mock.calls.map(
        ([args]: [{ data: { limitUsd: Prisma.Decimal } }]) => args.data.limitUsd.toFixed(2),
      );
      expect(limits).toEqual(['3.00', '0.00']);
    });
  });

  it('a fallback without a price and without a stage cap is 400 (Р24)', async () => {
    await expect(
      service.updateStageSetting('jev', { model: 'a/priced', fallbacks: ['c/dynamic'] }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.llmStageSetting.upsert).not.toHaveBeenCalled();
  });

  it('status with a key and the ceiling row is ENABLED with amounts', async () => {
    budget.getBudget.mockResolvedValue({
      ceilingUsd: D(100),
      spentUsd: D('1.5'),
      reservedUsd: D('0.25'),
      defaultRunLimitUsd: D(10),
    });
    await expect(service.status()).resolves.toEqual({
      state: 'ENABLED',
      keyConfigured: true,
      budgetConfigured: true,
      ceilingUsd: '100.00000000',
      spentUsd: '1.50000000',
      reservedUsd: '0.25000000',
      defaultRunLimitUsd: '10.00000000',
    });
  });

  describe('round 2', () => {
    it('a model change keeps a stage the admin switched off switched off', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue({ enabled: false });
      await service.updateStageSetting('on', { model: 'b/second' }, null);
      const data = (prisma.llmStageSetting.upsert.mock.calls[0][0] as { update: LlmStageSetting })
        .update;
      expect(data.enabled).toBe(false);
    });

    it('an unpriced fallback is skipped instead of failing the call', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ model: 'a/priced', fallbacks: ['c/dynamic', 'b/second'] }),
      );
      await service.callStage('op', 'jev', [{ role: 'user', content: 'x' }]);
      const models = (client.chat.mock.calls[0][0] as { models: LlmCallModel[] }).models;
      expect(models.map((m) => m.id)).toEqual(['a/priced', 'b/second']);
    });

    it('createOperation survives an unavailable model list: snapshot without prices', async () => {
      models.list.mockRejectedValue(new Error('down'));
      await service.createOperation({ kind: 'compare', limitUsd: D(1) });
      const data = (
        prisma.llmOperation.create.mock.calls[0][0] as {
          data: { settingsSnapshot: { prices: unknown } };
        }
      ).data;
      expect(data.settingsSnapshot.prices).toBeNull();
    });

    it('logs a DISABLED module at startup', () => {
      key = '';
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      service.onModuleInit();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DISABLED'));
      warn.mockRestore();
    });
  });

  it('an override row without its own price cap keeps the registry cap', async () => {
    const registry = (service as unknown as { registry: LlmStageRegistry }).registry;
    registry.register({
      stage: 'router',
      model: 'c/dynamic',
      fallbacks: [],
      temperature: null,
      maxTokens: 10,
      enabled: true,
      maxPricePerMTok: '2',
    });
    prisma.llmStageSetting.findUnique.mockResolvedValue(
      row({ stage: 'router', model: 'c/dynamic', maxPricePerMTok: null }),
    );
    await service.callStage('op', 'router', [{ role: 'user', content: 'x' }]);
    const [model] = (client.chat.mock.calls[0][0] as { models: LlmCallModel[] }).models;
    expect(model.maxPricePerMTok?.toFixed(2)).toBe('2.00');
  });

  describe('stageFit with one model (compare, F05-3)', () => {
    it('checks the context of that model only, not of the stage model and fallbacks', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ stage: 'on', model: 'a/priced', fallbacks: [] }),
      );
      models.list.mockResolvedValue(
        MODELS.map((m) =>
          m.id === 'a/priced'
            ? { ...m, contextLength: 1_000_000 }
            : m.id === 'b/second'
              ? { ...m, contextLength: 1_000 }
              : m,
        ),
      );
      const request = { messages: [{ role: 'user' as const, content: 'x'.repeat(40_000) }] };
      await expect(service.stageFit('on', request, 'b/second')).resolves.toEqual({
        fits: false,
        model: 'b/second',
      });
      await expect(service.stageFit('on', request)).resolves.toMatchObject({ fits: true });
    });
  });

  describe('stageFit (context check of a stage call)', () => {
    const ctxModels = (contextLength: number | null): LlmModelInfo[] =>
      MODELS.map((m) => (m.id === 'a/priced' ? { ...m, contextLength } : m));
    const request = (chars: number) => ({
      messages: [{ role: 'user' as const, content: 'x'.repeat(chars) }],
    });

    it('counts the input in tokens, not characters: 250k chars fit a 200k context', async () => {
      models.list.mockResolvedValue(ctxModels(200_000));
      await expect(service.stageFit('on', request(250_000))).resolves.toMatchObject({
        fits: true,
      });
    });

    it('counts 2.5 characters a token (F05-R, Р3): 440k chars do not fit a 160k context', async () => {
      // По 4 символа на токен это 110k и «влезало»; провайдер отвечал отказом уже оплаченному вызову.
      models.list.mockResolvedValue(ctxModels(160_000));
      await expect(service.stageFit('on', request(440_000))).resolves.toMatchObject({
        fits: false,
      });
    });

    it('395k chars still fit a 160k context: the divisor is 2.5, not below (F05-R, Р3)', async () => {
      // 395 016 / 2,5 = 158 007 + maxTokens влезает; при 2,4 - 164 590 и уже нет.
      models.list.mockResolvedValue(ctxModels(160_000));
      await expect(service.stageFit('on', request(395_000))).resolves.toMatchObject({
        fits: true,
      });
    });

    it('the summary divisor 2.26 refuses what fits at 2.5 (F05-Rb, Р1)', async () => {
      // 395k символов влезают в 160k по 2,5 (тест выше), по 2,26 это уже ~174,8k токенов входа.
      models.list.mockResolvedValue(ctxModels(160_000));
      await expect(
        service.stageFit('on', request(395_000), undefined, [], SUMMARY_INPUT_CHARS_PER_TOKEN),
      ).resolves.toMatchObject({ fits: false });
      const ceiling = await service.stageInputCeiling('on', {
        charsPerToken: SUMMARY_INPUT_CHARS_PER_TOKEN,
      });
      const plain = await service.stageInputCeiling('on');
      expect(ceiling.maxInputChars).toBeLessThan(395_000);
      expect(plain.maxInputChars).toBeGreaterThanOrEqual(395_000);
      // Граница одна у stageFit и stageInputCeiling: ровно на ней влезает, символом больше - нет.
      const edge = plain.maxInputChars as number;
      const fitsAt = (chars: number) =>
        service.stageFit('on', { messages: [{ role: 'user', content: 'x'.repeat(chars - 16) }] });
      await expect(fitsAt(Math.floor(edge))).resolves.toMatchObject({ fits: true });
      await expect(fitsAt(Math.floor(edge) + 1)).resolves.toMatchObject({ fits: false });
    });

    it('the input ceiling is null when no model context is known', async () => {
      models.list.mockResolvedValue(ctxModels(null));
      await expect(service.stageInputCeiling('on')).resolves.toMatchObject({ maxInputChars: null });
    });

    it('900k chars do not fit a 200k context', async () => {
      models.list.mockResolvedValue(ctxModels(200_000));
      await expect(service.stageFit('on', request(900_000))).resolves.toMatchObject({
        fits: false,
        model: 'a/priced',
      });
    });

    it('the smallest context among the model and its fallbacks decides; unknown context fits', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(
        row({ stage: 'on', model: 'a/priced', fallbacks: ['b/second'] }),
      );
      models.list.mockResolvedValue(
        MODELS.map((m) =>
          m.id === 'a/priced'
            ? { ...m, contextLength: 1_000_000 }
            : m.id === 'b/second'
              ? { ...m, contextLength: 50_000 }
              : m,
        ),
      );
      await expect(service.stageFit('on', request(250_000))).resolves.toMatchObject({
        fits: false,
      });
      models.list.mockResolvedValue(ctxModels(null));
      prisma.llmStageSetting.findUnique.mockResolvedValue(null);
      await expect(service.stageFit('on', request(5_000_000))).resolves.toMatchObject({
        fits: true,
      });
    });
  });
});
