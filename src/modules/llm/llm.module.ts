import { Module } from '@nestjs/common';
import { LlmBudgetService } from './llm-budget.service';
import { LlmModelsService } from './llm-models.service';
import { LlmStageRegistry } from './llm-stages.registry';
import { LlmConfig } from './llm.config';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { OpenRouterClient } from './openrouter.client';

/**
 * LLM-конвейер (F05, ADR-021): клиент OpenRouter, настройки этапов, цены, бюджет и журнал
 * вызовов. Без ключа модуль в состоянии DISABLED: приложение стартует, ручки настроек работают,
 * вызовы модели отвечают 503 `LLM_DISABLED`.
 */
@Module({
  controllers: [LlmController],
  providers: [
    LlmConfig,
    LlmStageRegistry,
    LlmModelsService,
    LlmBudgetService,
    OpenRouterClient,
    LlmService,
  ],
  // Бюджет и конфиг - для исполнителя `F05-1w` (чистка зависших вызовов, состояние воркера) и
  // для отказа кнопки досье на исчерпанном потолке (`F05-2`, `ceilingReached`): деньги пишутся
  // только здесь, второй копии SQL не будет.
  exports: [LlmService, LlmStageRegistry, LlmBudgetService, LlmConfig],
})
export class LlmModule {}
