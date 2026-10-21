import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { LlmBudget, LlmOperationKind, LlmStageSetting, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LlmBudgetResponseDto,
  LlmModelDto,
  LlmStageSettingDto,
  LlmStatusResponseDto,
} from './dto/llm-response.dto';
import { UpdateLlmBudgetDto } from './dto/update-llm-budget.dto';
import { UpdateLlmStageSettingDto } from './dto/update-llm-stage-setting.dto';
import { LlmBudgetService } from './llm-budget.service';
import { LlmModelInfo, LlmModelsService } from './llm-models.service';
import { LlmStageDefinition, LlmStageRegistry } from './llm-stages.registry';
import { LlmConfig } from './llm.config';
import { LlmError, llmDisabled } from './llm.errors';
import { LlmCallModel, LlmChatMessage, LlmChatResult, OpenRouterClient } from './openrouter.client';

const PER_MTOK = new Prisma.Decimal(1_000_000);

/** Действующая настройка этапа: умолчание из кода, поверх - строка из базы. */
export interface EffectiveStageSetting extends Omit<LlmStageDefinition, 'maxPricePerMTok'> {
  maxPricePerMTok: Prisma.Decimal | null;
  source: 'default' | 'override';
  updatedAt: Date | null;
}

export interface CreateOperationInput {
  kind: LlmOperationKind;
  bookVersionId?: string | null;
  /** Не задан - умолчание лимита запуска из `LlmBudget` (В1). */
  limitUsd?: Prisma.Decimal;
  createdById?: string | null;
}

export interface CallStageOptions {
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  beforeAttempt?: () => Promise<void> | void;
  signal?: AbortSignal;
  taskId?: string | null;
}

function money(value: Prisma.Decimal): string {
  return value.toFixed(8);
}

/**
 * Вход модуля LLM для остальных модулей и ручек админки. Модель зовут только `createOperation`
 * и `callStage` - оба отказывают 503 `LLM_DISABLED` без ключа. Ни одна ручка их не вызывает:
 * операции ставят пачки конвейера, начиная с `F05-1w` (Р25).
 */
@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: LlmConfig,
    private readonly registry: LlmStageRegistry,
    private readonly models: LlmModelsService,
    private readonly budget: LlmBudgetService,
    private readonly client: OpenRouterClient,
  ) {}

  /** Проверка конфига на старте (`tech.md` §8): выключенный модуль виден в логе, а не только в ручке. */
  onModuleInit(): void {
    if (!this.config.enabled()) {
      this.logger.warn(
        'LLM module is DISABLED: OPENROUTER_API_KEY is not set; model calls answer 503',
      );
    }
  }

  async status(): Promise<LlmStatusResponseDto> {
    const enabled = this.config.enabled();
    const budget = await this.budget.getBudget();
    return {
      state: enabled ? 'ENABLED' : 'DISABLED',
      keyConfigured: enabled,
      budgetConfigured: budget !== null,
      ceilingUsd: budget ? money(budget.ceilingUsd) : null,
      spentUsd: budget ? money(budget.spentUsd) : null,
      reservedUsd: budget ? money(budget.reservedUsd) : null,
      defaultRunLimitUsd: budget ? money(budget.defaultRunLimitUsd) : null,
    };
  }

  async listModels(): Promise<LlmModelDto[]> {
    const models = await this.models.list();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      inputPerMTokUsd: m.price.input ? money(m.price.input.mul(PER_MTOK)) : null,
      outputPerMTokUsd: m.price.output ? money(m.price.output.mul(PER_MTOK)) : null,
      structuredOutputs: m.structuredOutputs,
    }));
  }

  async updateBudget(
    dto: UpdateLlmBudgetDto,
    userId: string | null,
  ): Promise<LlmBudgetResponseDto> {
    const budget = await this.budget.updateBudget(
      {
        ...(dto.ceilingUsd != null && { ceilingUsd: new Prisma.Decimal(dto.ceilingUsd) }),
        ...(dto.defaultRunLimitUsd != null && {
          defaultRunLimitUsd: new Prisma.Decimal(dto.defaultRunLimitUsd),
        }),
      },
      userId,
    );
    if (!budget) throw new NotFoundException('LLM budget row is missing');
    return toBudgetDto(budget);
  }

  async listStageSettings(): Promise<LlmStageSettingDto[]> {
    const rows = await this.prisma.llmStageSetting.findMany({
      where: { stage: { in: this.registry.list().map((s) => s.stage) } },
    });
    const byStage = new Map(rows.map((r) => [r.stage, r]));
    return this.registry.list().map((def) => toStageDto(merge(def, byStage.get(def.stage))));
  }

  async getStageSetting(stage: string): Promise<EffectiveStageSetting> {
    const def = this.registry.get(stage);
    if (!def) throw new LlmError('LLM_UNKNOWN_STAGE', `Unknown LLM stage "${stage}"`);
    const row = await this.prisma.llmStageSetting.findUnique({ where: { stage } });
    return merge(def, row ?? undefined);
  }

  /**
   * Модель и запасные - только из списка OpenRouter; у каждой должна быть цена или
   * `maxPricePerMTok`, иначе резерв не посчитать (Р24). Правило семейств - не здесь.
   */
  async updateStageSetting(
    stage: string,
    dto: UpdateLlmStageSettingDto,
    userId: string | null,
  ): Promise<LlmStageSettingDto> {
    const def = this.registry.get(stage);
    if (!def) throw new NotFoundException(`Unknown LLM stage "${stage}"`);

    const fallbacks = dto.fallbacks ?? [];
    const maxPrice = dto.maxPricePerMTok != null ? new Prisma.Decimal(dto.maxPricePerMTok) : null;
    // Потолок цены 0 дал бы резерв 0 у модели без цены - потолок бюджета её бы не держал (Р4).
    if (maxPrice && maxPrice.lte(0)) {
      throw new BadRequestException('maxPricePerMTok must be greater than 0');
    }
    // Основная в запасных или повтор запасной - лишние платные попытки той же модели.
    if (new Set([dto.model, ...fallbacks]).size !== fallbacks.length + 1) {
      throw new BadRequestException('Fallbacks must be distinct and differ from the model');
    }
    const [models, existing] = await Promise.all([
      this.models.list(),
      this.prisma.llmStageSetting.findUnique({ where: { stage }, select: { enabled: true } }),
    ]);
    const known = new Map(models.map((m) => [m.id, m]));
    for (const id of [dto.model, ...fallbacks]) {
      const model = known.get(id);
      if (!model)
        throw new BadRequestException(`Model "${id}" is not in the OpenRouter model list`);
      if (!hasPrice(model) && !maxPrice) {
        throw new BadRequestException(
          `Model "${id}" has no fixed price: set maxPricePerMTok for this stage`,
        );
      }
    }

    const data = {
      model: dto.model,
      fallbacks,
      // null - умолчание этапа из реестра (как у maxTokens), а не «без температуры».
      temperature: dto.temperature ?? null,
      maxTokens: dto.maxTokens ?? null,
      // Не передан - прежнее значение строки, без строки - умолчание реестра: смена модели
      // не включает ни выключенный админом этап, ни выключенный по умолчанию.
      enabled: dto.enabled ?? existing?.enabled ?? def.enabled,
      maxPricePerMTok: maxPrice,
      updatedById: userId,
    };
    const row = await this.prisma.llmStageSetting.upsert({
      where: { stage },
      create: { stage, ...data },
      update: data,
    });
    return toStageDto(merge(def, row));
  }

  /** Операция с лимитом: всё, что тратит деньги, тратит их на операцию. */
  async createOperation(input: CreateOperationInput): Promise<{ id: string }> {
    if (!this.config.enabled()) throw llmDisabled();
    const [budget, stages, catalog] = await Promise.all([
      input.limitUsd ? null : this.budget.getBudget(),
      this.listStageSettings(),
      // Снимок - журнал: без списка моделей операция создаётся, просто без цен в снимке.
      this.listModels().catch(() => null),
    ]);
    // Нет строки потолка - лимит 0: вызов всё равно отклонится по потолку (В4).
    const limitUsd = input.limitUsd ?? budget?.defaultRunLimitUsd ?? new Prisma.Decimal(0);
    const used = new Set(stages.flatMap((s) => [s.model, ...s.fallbacks]));
    const prices = catalog ? catalog.filter((m) => used.has(m.id)) : null;
    const snapshot = { takenAt: new Date().toISOString(), stages, prices };
    return this.prisma.llmOperation.create({
      data: {
        kind: input.kind,
        bookVersionId: input.bookVersionId ?? null,
        limitUsd,
        createdById: input.createdById ?? null,
        settingsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }

  /** Вызов этапа на текущих настройках: смена модели `PUT` действует со следующего вызова. */
  async callStage(
    operationId: string,
    stage: string,
    messages: LlmChatMessage[],
    options: CallStageOptions = {},
  ): Promise<LlmChatResult> {
    if (!this.config.enabled()) throw llmDisabled();
    const setting = await this.getStageSetting(stage);
    if (!setting.enabled)
      throw new LlmError('LLM_STAGE_DISABLED', `LLM stage "${stage}" is disabled`);

    const known = new Map((await this.models.list()).map((m) => [m.id, m]));
    // Основная без цены - отказ; запасная без цены (снята с OpenRouter, цена стала
    // динамической) пропускается, а не роняет вызов, пока основная работает.
    const primary = priced(setting.model, known.get(setting.model), setting.maxPricePerMTok);
    const fallbacks = setting.fallbacks.flatMap((id) => {
      try {
        return [priced(id, known.get(id), setting.maxPricePerMTok)];
      } catch {
        this.logger.warn(`LLM stage ${stage}: fallback ${id} has no price, skipped`);
        return [];
      }
    });
    const models = [primary, ...fallbacks];
    return this.client.chat({
      operationId,
      stage,
      models,
      messages,
      temperature: setting.temperature,
      maxTokens: setting.maxTokens,
      jsonSchema: options.jsonSchema,
      beforeAttempt: options.beforeAttempt,
      signal: options.signal,
      taskId: options.taskId,
    });
  }
}

function hasPrice(model: LlmModelInfo): boolean {
  return model.price.input !== null && model.price.output !== null;
}

/** Цена модели для резерва: из списка OpenRouter, иначе потолок цены этапа (Р24). */
function priced(
  id: string,
  model: LlmModelInfo | undefined,
  maxPricePerMTok: Prisma.Decimal | null,
): LlmCallModel {
  if (model && hasPrice(model)) {
    return {
      id,
      inputPrice: model.price.input as Prisma.Decimal,
      outputPrice: model.price.output as Prisma.Decimal,
      structuredOutputs: model.structuredOutputs,
    };
  }
  if (!maxPricePerMTok) {
    throw new LlmError(
      'LLM_NO_PRICE',
      `Model "${id}" has no price and the stage has no maxPricePerMTok`,
    );
  }
  const perToken = maxPricePerMTok.div(PER_MTOK);
  return {
    id,
    inputPrice: perToken,
    outputPrice: perToken,
    structuredOutputs: model?.structuredOutputs ?? false,
    maxPricePerMTok,
  };
}

function merge(def: LlmStageDefinition, row: LlmStageSetting | undefined): EffectiveStageSetting {
  if (!row) {
    return {
      ...def,
      maxPricePerMTok: def.maxPricePerMTok ? new Prisma.Decimal(def.maxPricePerMTok) : null,
      source: 'default',
      updatedAt: null,
    };
  }
  const fallbacks = Array.isArray(row.fallbacks)
    ? row.fallbacks.filter((f): f is string => typeof f === 'string')
    : [];
  return {
    stage: def.stage,
    model: row.model,
    fallbacks,
    temperature: row.temperature ?? def.temperature,
    maxTokens: row.maxTokens ?? def.maxTokens,
    enabled: row.enabled,
    maxPricePerMTok:
      row.maxPricePerMTok ?? (def.maxPricePerMTok ? new Prisma.Decimal(def.maxPricePerMTok) : null),
    source: 'override',
    updatedAt: row.updatedAt,
  };
}

function toStageDto(s: EffectiveStageSetting): LlmStageSettingDto {
  return {
    stage: s.stage,
    model: s.model,
    fallbacks: s.fallbacks,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    enabled: s.enabled,
    maxPricePerMTok: s.maxPricePerMTok ? money(s.maxPricePerMTok) : null,
    source: s.source,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  };
}

function toBudgetDto(b: LlmBudget): LlmBudgetResponseDto {
  return {
    ceilingUsd: money(b.ceilingUsd),
    spentUsd: money(b.spentUsd),
    reservedUsd: money(b.reservedUsd),
    defaultRunLimitUsd: money(b.defaultRunLimitUsd),
    updatedAt: b.updatedAt.toISOString(),
  };
}
