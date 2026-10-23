import { Module, OnModuleInit } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { LlmStageRegistry } from '../llm/llm-stages.registry';
import { LlmOperationKindRegistry } from '../llm-worker/llm-operation-kind.registry';
import { LlmTaskHandlerRegistry } from '../llm-worker/llm-task-handler.registry';
import { LlmWorkerModule } from '../llm-worker/llm-worker.module';
import { COMPARE_TASK_KIND } from './compare/compare.constants';
import { TranslationCompareService } from './compare/compare.service';
import { CompareTasksHandler } from './compare/compare-tasks.handler';
import {
  DOSSIER_STAGE_DEFINITIONS,
  DOSSIER_TASK_KIND,
  GLOSSARY_TASK_KIND,
} from './dossier/dossier.constants';
import { DossierService } from './dossier/dossier.service';
import { DossierTasksHandler } from './dossier/dossier-tasks.handler';
import { TRANSLATION_RUN_TASK_KIND } from './run/translation-run.constants';
import { TranslationRunService } from './run/translation-run.service';
import { TranslationRunTasksHandler } from './run/translation-run-tasks.handler';
import { TranslationController } from './translation.controller';
import { TranslationSourceService } from './translation-source.service';
import { TRANSLATE_STAGE_DEFINITIONS } from './translate/translate.constants';
import { CHECK_STAGE_DEFINITIONS } from './check/check.constants';

/**
 * Автоперевод книги (F05): исходник по D8, блоки главы, отпечаток текста, досье и глоссарий
 * (`F05-2`), нарезка, перевод куска и сравнение моделей на главе (`F05-3`), шаги запуска
 * перевода по языкам (`F05-4`). Этапы, виды задач и виды операций `dossier`, `compare`
 * и `translation_run` регистрируются здесь: исполнитель стартует в `onApplicationBootstrap`,
 * после этого `onModuleInit`.
 */
@Module({
  imports: [LlmModule, LlmWorkerModule],
  controllers: [TranslationController],
  providers: [
    TranslationSourceService,
    DossierService,
    DossierTasksHandler,
    TranslationCompareService,
    CompareTasksHandler,
    TranslationRunService,
    TranslationRunTasksHandler,
  ],
})
export class TranslationModule implements OnModuleInit {
  constructor(
    private readonly stages: LlmStageRegistry,
    private readonly handlers: LlmTaskHandlerRegistry,
    private readonly kinds: LlmOperationKindRegistry,
    private readonly dossierTasks: DossierTasksHandler,
    private readonly compareTasks: CompareTasksHandler,
    private readonly runTasks: TranslationRunTasksHandler,
  ) {}

  onModuleInit(): void {
    for (const definition of DOSSIER_STAGE_DEFINITIONS) this.stages.register(definition);
    this.handlers.register(DOSSIER_TASK_KIND, this.dossierTasks.dossierHandler);
    this.handlers.register(GLOSSARY_TASK_KIND, this.dossierTasks.glossaryHandler);
    this.kinds.register('dossier', this.dossierTasks);
    for (const definition of TRANSLATE_STAGE_DEFINITIONS) this.stages.register(definition);
    for (const definition of CHECK_STAGE_DEFINITIONS) this.stages.register(definition);
    this.handlers.register(COMPARE_TASK_KIND, this.compareTasks.handler);
    this.kinds.register('compare', this.compareTasks);
    this.handlers.register(TRANSLATION_RUN_TASK_KIND, this.runTasks.handler);
    this.kinds.register('translation_run', this.runTasks);
  }
}
