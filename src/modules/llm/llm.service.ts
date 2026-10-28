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
import { moneyUsd } from './dto/llm-money';
import { UpdateLlmBudgetDto } from './dto/update-llm-budget.dto';
import { UpdateLlmStageSettingDto } from './dto/update-llm-stage-setting.dto';
import { LlmBudgetService } from './llm-budget.service';
import { LlmModelInfo, LlmModelsService } from './llm-models.service';
import { LlmStageDefinition, LlmStageRegistry } from './llm-stages.registry';
import { LlmConfig } from './llm.config';
import { LlmError, llmDisabled } from './llm.errors';
import {
  INPUT_CHARS_PER_TOKEN,
  estimateInputTokens,
  LlmCallModel,
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmJsonSchema,
  OpenRouterClient,
  reserveInputTokens,
} from './openrouter.client';

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
  /** Модели вне настроек этапов, которые операция позовёт сама (сравнение `F05-3`): их цены - в снимке. */
  models?: readonly string[];
  /** Запуск перевода, ради которого заведена операция (`F05-4`): отчёт и история запуска. */
  translationRunId?: string | null;
}

/**
 * Символов входа, которые влезут в контекст вместе с ответом: (контекст - `maxTokens`) × делитель.
 * Одна формула на `stageFit`, `stageInputCeiling` и оценку сводки досье (решение арбитра
 * `F05 | F05-Rb`, Р5): правка границы не обходит ни одного из них.
 */
export function inputCeilingChars(
  contextLength: number,
  maxTokens: number,
  charsPerToken: number,
): number {
  return (contextLength - maxTokens) * charsPerToken;
}

/**
 * Оценка вызова этапа: вход по той же оценке токенов, что у резерва клиента, выход - `maxTokens`.
 * `extraInputTokens` - вход, которого в запросе ещё нет (ответы прошлых шагов).
 */
export interface StageCallEstimator {
  maxTokens: number;
  /** Этап выключен на экране «LLM settings»: вызов отказал бы `LLM_STAGE_DISABLED`. */
  enabled: boolean;
  /** Наименьший контекст основной и запасных моделей в токенах; `null` - неизвестен. */
  contextLength: number | null;
  estimate(
    request: Pick<LlmChatRequest, 'messages' | 'jsonSchema'>,
    extraInputTokens?: number,
  ): Prisma.Decimal;
}

export interface CallStageOptions {
  jsonSchema?: LlmJsonSchema;
  beforeAttempt?: () => Promise<void> | void;
  signal?: AbortSignal;
  taskId?: string | null;
  /**
   * Одна модель вместо модели и запасных этапа (сравнение `F05-3`, решение арбитра
   * `F05 | F05-3`, С7): запасные подменили бы текст колонки чужим. Остальное - из настройки этапа.
   */
  model?: string;
  /**
   * Запасные модели вместо запасных этапа - только вместе с `model` (снимок запуска перевода
   * `F05-4`, решение арбитра `F05 | F05-4a`, В1); без `model` не читается.
   */
  fallbacks?: readonly string[];
}

/**
 * Вход модуля LLM для остальных модулей и ручек админки. Операцию заводят `createOperation`
 * и `operationData` (строка для короткой транзакции модуля, который её строит), модель зовёт
 * `callStage`; все трое отказывают 503 `LLM_DISABLED` без ключа. Оценка вызова этапа -
 * `stageCallEstimator`. Модель не зовёт ни одна ручка; операцию из ручки заводит только кнопка
 * досье (`POST /admin/versions/:id/dossier`, `F05-2`), сам вызов идёт фоном исполнителя (Р25).
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
      ceilingUsd: budget ? moneyUsd(budget.ceilingUsd) : null,
      spentUsd: budget ? moneyUsd(budget.spentUsd) : null,
      reservedUsd: budget ? moneyUsd(budget.reservedUsd) : null,
      defaultRunLimitUsd: budget ? moneyUsd(budget.defaultRunLimitUsd) : null,
    };
  }

  async listModels(): Promise<LlmModelDto[]> {
    const models = await this.models.list();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      inputPerMTokUsd: m.price.input ? moneyUsd(m.price.input.mul(PER_MTOK)) : null,
      outputPerMTokUsd: m.price.output ? moneyUsd(m.price.output.mul(PER_MTOK)) : null,
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

  /**
   * Оценка одного вызова этапа сверху - так же, как его резерв в клиенте: вход по оценке
   * токенов, выход - `maxTokens` этапа, цена основной модели (Р4, Р24). Для окна запуска
   * и лимита операции, а не для расчёта факта. Настройка и цена читаются один раз на оценку.
   */
  async stageCallEstimator(stage: string, modelId?: string): Promise<StageCallEstimator> {
    const setting = await this.getStageSetting(stage);
    const known = new Map((await this.models.list()).map((m) => [m.id, m]));
    const primary = modelId ?? setting.model;
    const model = priced(primary, known.get(primary), setting.maxPricePerMTok);
    const output = model.outputPrice.mul(setting.maxTokens);
    const contexts = (modelId ? [modelId] : [setting.model, ...setting.fallbacks])
      .map((id) => known.get(id)?.contextLength)
      .filter((c): c is number => typeof c === 'number');
    return {
      maxTokens: setting.maxTokens,
      enabled: setting.enabled,
      contextLength: contexts.length > 0 ? Math.min(...contexts) : null,
      estimate: (request, extraInputTokens = 0) =>
        model.inputPrice
          .mul(reserveInputTokens(model, estimateInputTokens(request) + extraInputTokens))
          .add(output),
    };
  }

  /**
   * Влезет ли вызов этапа в контекст: вход в токенах (символы / `INPUT_CHARS_PER_TOKEN`) плюс
   * `maxTokens` против наименьшего контекста основной и запасных моделей (вызов может уйти на
   * любую). Контекст неизвестен ни у одной - влезает, решает провайдер. Цена не нужна.
   * `charsPerToken` - делитель входа: у сводки досье из чистого JSON свой (`F05-Rb`, Р1).
   */
  async stageFit(
    stage: string,
    request: Pick<LlmChatRequest, 'messages' | 'jsonSchema'>,
    modelId?: string,
    fallbacks: readonly string[] = [],
    charsPerToken: number = INPUT_CHARS_PER_TOKEN,
  ): Promise<{ fits: boolean; model: string }> {
    const { maxInputChars, model } = await this.stageInputCeiling(stage, {
      model: modelId,
      fallbacks,
      charsPerToken,
    });
    return {
      fits: maxInputChars === null || estimateInputTokens(request) <= maxInputChars,
      model,
    };
  }

  /**
   * Сколько символов входа влезет в вызов этапа: (наименьший контекст основной и запасных -
   * `maxTokens`) × делитель - та же граница, что у `stageFit`. `null` - контекст неизвестен ни
   * у одной модели. Нужна тому, кто читает вход страницами и останавливается на границе
   * (заготовки `F05-Rb`, Р2), а не собирает его целиком ради одной проверки.
   */
  async stageInputCeiling(
    stage: string,
    options: {
      model?: string;
      fallbacks?: readonly string[];
      charsPerToken?: number;
    } = {},
  ): Promise<{ maxInputChars: number | null; model: string }> {
    const setting = await this.getStageSetting(stage);
    const known = await this.known();
    // Модели - ровно те, что уйдут в вызов (`callModels`, как в `callStage`): запасная без цены
    // туда не попадёт, и её контекст не должен отказывать куску (`F05-4a`).
    const { primaryId, fallbacks: called } = this.callModels(
      stage,
      setting,
      { model: options.model, fallbacks: options.fallbacks ?? [] },
      known,
    );
    const contexts = [primaryId, ...called.map((m) => m.id)]
      .map((id) => known.get(id)?.contextLength)
      .filter((c): c is number => typeof c === 'number');
    // Вход - в настоящих токенах (символы / делитель), а не верхней границей резерва: символ
    // за токен ложно отказал бы книге, которая влезает (решение арбитра `F05 | F05-2`).
    const charsPerToken = options.charsPerToken ?? INPUT_CHARS_PER_TOKEN;
    return {
      maxInputChars:
        contexts.length === 0
          ? null
          : inputCeilingChars(Math.min(...contexts), setting.maxTokens, charsPerToken),
      model: options.model ?? setting.model,
    };
  }

  /** Ключа нет - 503 `LLM_DISABLED` до любой другой проверки ручки, которая заведёт операцию. */
  assertEnabled(): void {
    if (!this.config.enabled()) throw llmDisabled();
  }

  /** Операция с лимитом: всё, что тратит деньги, тратит их на операцию. */
  async createOperation(input: CreateOperationInput): Promise<{ id: string }> {
    return this.prisma.llmOperation.create({
      data: await this.operationData(input),
      select: { id: true },
    });
  }

  /**
   * Строка операции без записи: лимит и снимок настроек. Отдельно от `createOperation` - для
   * операции, которая заводится в одной короткой транзакции со строкой, которую она строит
   * (досье `F05-2`): каталог моделей читается до транзакции, а не внутри неё (`L-020`).
   */
  async operationData(
    input: CreateOperationInput,
  ): Promise<Prisma.LlmOperationUncheckedCreateInput> {
    if (!this.config.enabled()) throw llmDisabled();
    const [budget, stages, catalog] = await Promise.all([
      input.limitUsd ? null : this.budget.getBudget(),
      this.listStageSettings(),
      // Снимок - журнал: без списка моделей операция создаётся, просто без цен в снимке.
      this.listModels().catch(() => null),
    ]);
    // Нет строки потолка - лимит 0: вызов всё равно отклонится по потолку (В4).
    const limitUsd = input.limitUsd ?? budget?.defaultRunLimitUsd ?? new Prisma.Decimal(0);
    const used = new Set([
      ...stages.flatMap((s) => [s.model, ...s.fallbacks]),
      ...(input.models ?? []),
    ]);
    const prices = catalog ? catalog.filter((m) => used.has(m.id)) : null;
    const snapshot = { takenAt: new Date().toISOString(), stages, prices };
    return {
      kind: input.kind,
      bookVersionId: input.bookVersionId ?? null,
      limitUsd,
      createdById: input.createdById ?? null,
      translationRunId: input.translationRunId ?? null,
      settingsSnapshot: snapshot as unknown as Prisma.InputJsonValue,
    };
  }

  /**
   * Модели, которые позовёт `callStage` с теми же `model`/`fallbacks`: основная и запасные с
   * ценой - запасная без цены пропускается так же, как в вызове (модели отказа запуска
   * перевода, `F05-4a`, В4).
   */
  async stageCallModels(
    stage: string,
    options: { model?: string; fallbacks?: readonly string[] } = {},
  ): Promise<string[]> {
    const setting = await this.getStageSetting(stage);
    const { primaryId, fallbacks } = this.callModels(stage, setting, options, await this.known());
    return [primaryId, ...fallbacks.map((m) => m.id)];
  }

  private async known(): Promise<Map<string, LlmModelInfo>> {
    return new Map((await this.models.list()).map((m) => [m.id, m]));
  }

  /**
   * Модели вызова этапа - одно правило на `callStage` и `stageCallModels`. Основная без цены -
   * отказ при вызове; запасная без цены (снята с OpenRouter, цена стала динамической)
   * пропускается, а не роняет вызов, пока основная работает. `model` - ровно она с `fallbacks`
   * (без них - без запасных: модель сравнения `F05-3`, `stageModels` запуска `F05-4`).
   */
  private callModels(
    stage: string,
    setting: EffectiveStageSetting,
    options: { model?: string; fallbacks?: readonly string[] },
    known: Map<string, LlmModelInfo>,
  ): { primaryId: string; fallbacks: LlmCallModel[] } {
    const primaryId = options.model ?? setting.model;
    const fallbackIds = options.model ? (options.fallbacks ?? []) : setting.fallbacks;
    const fallbacks = fallbackIds.flatMap((id) => {
      try {
        return [priced(id, known.get(id), setting.maxPricePerMTok)];
      } catch {
        this.logger.warn(`LLM stage ${stage}: fallback ${id} has no price, skipped`);
        return [];
      }
    });
    return { primaryId, fallbacks };
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

    const known = await this.known();
    const { primaryId, fallbacks } = this.callModels(stage, setting, options, known);
    const primary = priced(primaryId, known.get(primaryId), setting.maxPricePerMTok);
    const models = [primary, ...fallbacks];
    return this.client.chat({
      operationId,
      stage,
      models,
      messages,
      temperature: setting.temperature,
      maxTokens: setting.maxTokens,
      reasoningMaxTokens: reasoningCeiling(setting),
      jsonSchema: options.jsonSchema,
      beforeAttempt: options.beforeAttempt,
      signal: options.signal,
      taskId: options.taskId,
    });
  }
}

/**
 * Наименьший потолок рассуждений, который принимают все провайдеры (у Anthropic бюджет
 * рассуждений не меньше 1024): меньший остаток поднимается до него.
 */
const REASONING_MIN_TOKENS = 1_024;

/**
 * Потолок рассуждений от действующего `maxTokens`: лимит, сниженный на экране, опускает и его,
 * но не ниже `REASONING_MIN_TOKENS`. Лимит не больше резерва - потолка нет (решение арбитра
 * `F05 | F05-13a`, нижняя граница).
 */
function reasoningCeiling(setting: EffectiveStageSetting): number | undefined {
  const reserve = setting.reasoningAnswerReserve;
  if (reserve === undefined || setting.maxTokens <= reserve) return undefined;
  return Math.max(REASONING_MIN_TOKENS, setting.maxTokens - reserve);
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
    reasoningAnswerReserve: def.reasoningAnswerReserve,
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
    maxPricePerMTok: s.maxPricePerMTok ? moneyUsd(s.maxPricePerMTok) : null,
    source: s.source,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  };
}

function toBudgetDto(b: LlmBudget): LlmBudgetResponseDto {
  return {
    ceilingUsd: moneyUsd(b.ceilingUsd),
    spentUsd: moneyUsd(b.spentUsd),
    reservedUsd: moneyUsd(b.reservedUsd),
    defaultRunLimitUsd: moneyUsd(b.defaultRunLimitUsd),
    updatedAt: b.updatedAt.toISOString(),
  };
}
