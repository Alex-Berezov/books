import { Injectable } from '@nestjs/common';

/** Умолчание этапа в коде. Строка `LlmStageSetting` переопределяет его без выката. */
export interface LlmStageDefinition {
  stage: string;
  model: string;
  fallbacks: string[];
  temperature: number | null;
  /** Верхняя граница ответа: по ней считается резерв вызова. */
  maxTokens: number;
  enabled: boolean;
  /**
   * Потолок цены за миллион токенов - для умолчания с моделью без фиксированной цены
   * (`typesafe/jev-router`, Р24). Строка: деньги в Decimal, без float.
   */
  maxPricePerMTok?: string;
  /**
   * Токенов ответа, которые рассуждения не съедают: потолок рассуждений вызова - действующий
   * `maxTokens` минус резерв, не ниже 1024 (`reasoningCeiling` в `llm.service.ts`), уходит
   * провайдеру как `reasoning.max_tokens`. Только у проверяющих
   * этапов (`LEGACY-478`, решение арбитра `F05 | F05-13`); нет - рассуждения без потолка.
   */
  reasoningAnswerReserve?: number;
}

/**
 * Реестр этапов. Этап появляется вместе с пачкой, где у него есть код (`tech.md` §0 п.7), поэтому
 * в `F05-1` он пуст: этапы регистрирует модуль, которому они принадлежат, а тесты - свой
 * тестовый этап.
 */
@Injectable()
export class LlmStageRegistry {
  private readonly stages = new Map<string, LlmStageDefinition>();

  register(definition: LlmStageDefinition): void {
    if (this.stages.has(definition.stage)) {
      throw new Error(`LLM stage "${definition.stage}" is already registered`);
    }
    this.stages.set(definition.stage, { ...definition, fallbacks: [...definition.fallbacks] });
  }

  get(stage: string): LlmStageDefinition | undefined {
    return this.stages.get(stage);
  }

  list(): LlmStageDefinition[] {
    return [...this.stages.values()].sort((a, b) => a.stage.localeCompare(b.stage));
  }
}
