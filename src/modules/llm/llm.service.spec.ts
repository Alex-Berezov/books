import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmStageSetting, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmBudgetService } from './llm-budget.service';
import { LlmModelInfo, LlmModelsService } from './llm-models.service';
import { LlmStageRegistry } from './llm-stages.registry';
import { LlmConfig } from './llm.config';
import { LlmService } from './llm.service';
import { LlmCallModel, OpenRouterClient } from './openrouter.client';

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

    it('a row without temperature keeps the stage default', async () => {
      prisma.llmStageSetting.findUnique.mockResolvedValue(row({ temperature: null }));
      await call();
      expect(client.chat.mock.calls[0][0]).toMatchObject({ temperature: 0.3, maxTokens: 100 });
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
});
