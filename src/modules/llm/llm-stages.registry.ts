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
  /**
   * Таймаут вызова этапа, мс; нет - общий `LLM_CALL_TIMEOUT_MS`, больший общий действует и здесь.
   * Только в коде, не на экране: запасная проверяющая `deepseek-v4-pro` отвечает на длинном куске
   * за 310-340 с (`LEGACY-479`, решение арбитра `F05 | F05-13c`). От наибольшего из таймаутов считаются аренда задачи
   * и чистка зависших вызовов (`longestCallTimeoutMs`).
   */
  callTimeoutMs?: number;
  /**
   * Ответ, оборванный лимитом (`finish=length`) без разбираемого JSON, не повторяется: вызов сразу
   * переходит к следующей модели цепочки, на последней - отказ без повтора с замечанием. Повтор
   * идёт с тем же входом и лимитом и обрывается так же, а оплачивается заново (`LEGACY-480`,
   * решение арбитра `F05 | F05-13d`). Только у проверяющих этапов, только в коде.
   */
  truncationEndsModel?: boolean;
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

  /**
   * Самый длинный таймаут вызова среди этапов и общего: попытка любого этапа не длиннее его,
   * поэтому аренда задачи и порог зависшего вызова считаются от него, а не от общего.
   */
  longestCallTimeoutMs(defaultMs: number): number {
    return Math.max(defaultMs, ...[...this.stages.values()].map((s) => s.callTimeoutMs ?? 0));
  }
}
