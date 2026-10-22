import { Module, OnModuleInit } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { LlmStageRegistry } from '../llm/llm-stages.registry';
import { LlmOperationKindRegistry } from '../llm-worker/llm-operation-kind.registry';
import { LlmTaskHandlerRegistry } from '../llm-worker/llm-task-handler.registry';
import { LlmWorkerModule } from '../llm-worker/llm-worker.module';
import {
  DOSSIER_STAGE_DEFINITIONS,
  DOSSIER_TASK_KIND,
  GLOSSARY_TASK_KIND,
} from './dossier/dossier.constants';
import { DossierService } from './dossier/dossier.service';
import { DossierTasksHandler } from './dossier/dossier-tasks.handler';
import { TranslationController } from './translation.controller';
import { TranslationSourceService } from './translation-source.service';

/**
 * Автоперевод книги (F05): исходник по D8, блоки главы, отпечаток текста, досье и глоссарий
 * (`F05-2`). Этапы `dossier` и `glossary`, виды задач и вид операции `dossier` регистрируются
 * здесь: исполнитель стартует в `onApplicationBootstrap`, после этого `onModuleInit`.
 */
@Module({
  imports: [LlmModule, LlmWorkerModule],
  controllers: [TranslationController],
  providers: [TranslationSourceService, DossierService, DossierTasksHandler],
})
export class TranslationModule implements OnModuleInit {
  constructor(
    private readonly stages: LlmStageRegistry,
    private readonly handlers: LlmTaskHandlerRegistry,
    private readonly kinds: LlmOperationKindRegistry,
    private readonly dossierTasks: DossierTasksHandler,
  ) {}

  onModuleInit(): void {
    for (const definition of DOSSIER_STAGE_DEFINITIONS) this.stages.register(definition);
    this.handlers.register(DOSSIER_TASK_KIND, this.dossierTasks.dossierHandler);
    this.handlers.register(GLOSSARY_TASK_KIND, this.dossierTasks.glossaryHandler);
    this.kinds.register('dossier', this.dossierTasks);
  }
}
