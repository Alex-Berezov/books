import { Module } from '@nestjs/common';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';
import { LlmModule } from '../llm/llm.module';
import { LlmOperationKindRegistry } from './llm-operation-kind.registry';
import { LlmOperationsController } from './llm-operations.controller';
import { LlmOperationsService } from './llm-operations.service';
import { LlmTaskHandlerRegistry } from './llm-task-handler.registry';
import { LlmTaskService } from './llm-task.service';
import { LlmWorkerConfig } from './llm-worker.config';
import { LlmWorkerService } from './llm-worker.service';

/**
 * Фоновый исполнитель LLM (`F05-1w`, ADR-021): задачи на Postgres, реестр обработчиков,
 * переходы операции вместе с задачами. Потребитель `LlmModule`; обратной зависимости нет.
 * Модули конвейера регистрируют обработчики в `LlmTaskHandlerRegistry`, свои виды операций
 * в `LlmOperationKindRegistry` («продолжить», отмена) и ставят задачи через `LlmTaskService`.
 */
@Module({
  imports: [LlmModule, BackgroundJobsRegistryModule],
  controllers: [LlmOperationsController],
  providers: [
    LlmWorkerConfig,
    LlmTaskHandlerRegistry,
    LlmOperationKindRegistry,
    LlmTaskService,
    LlmOperationsService,
    LlmWorkerService,
  ],
  exports: [LlmTaskHandlerRegistry, LlmOperationKindRegistry, LlmTaskService],
})
export class LlmWorkerModule {}
