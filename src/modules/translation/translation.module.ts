import { Module, OnModuleInit } from '@nestjs/common';
import { BookVersionModule } from '../book-version/book-version.module';
import { ChapterModule } from '../chapter/chapter.module';
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
import { TranslationDraftService } from './draft/translation-draft.service';
import { TRANSLATION_RETRY_KIND } from './retry/chunk-retry';
import { ChunkRetryHandler } from './retry/chunk-retry.handler';
import { ChunkRetryService } from './retry/chunk-retry.service';
import { ChunkRewriteService } from './retry/chunk-rewrite.service';
import { TRANSLATION_RUN_TASK_KIND } from './run/translation-run.constants';
import { TranslationRunReportService } from './run/translation-run-report.service';
import { TranslationRunService } from './run/translation-run.service';
import { TranslationRunTasksHandler } from './run/translation-run-tasks.handler';
import { TranslationController } from './translation.controller';
import { TranslationSourceService } from './translation-source.service';
import { TRANSLATE_STAGE_DEFINITIONS } from './translate/translate.constants';
import { CHECK_STAGE_DEFINITIONS } from './check/check.constants';
import { METADATA_STAGE_DEFINITIONS } from './metadata/metadata.constants';
import { FINAL_CHECK_STAGE_DEFINITIONS } from './final-check/final-check.constants';

/**
 * Автоперевод книги (F05): исходник по D8, блоки главы, отпечаток текста, досье и глоссарий
 * (`F05-2`), нарезка, перевод куска и сравнение моделей на главе (`F05-3`), шаги запуска
 * перевода по языкам (`F05-4`), повтор и правка куска (`F05-7v`). Этапы, виды задач и виды
 * операций `dossier`, `compare`, `translation_run` и `translation_retry` регистрируются здесь: исполнитель стартует в `onApplicationBootstrap`,
 * после этого `onModuleInit`.
 */
@Module({
  imports: [LlmModule, LlmWorkerModule, BookVersionModule, ChapterModule],
  controllers: [TranslationController],
  providers: [
    TranslationSourceService,
    DossierService,
    DossierTasksHandler,
    TranslationCompareService,
    CompareTasksHandler,
    TranslationRunService,
    TranslationRunReportService,
    TranslationRunTasksHandler,
    TranslationDraftService,
    ChunkRewriteService,
    ChunkRetryService,
    ChunkRetryHandler,
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
    private readonly retryTasks: ChunkRetryHandler,
  ) {}

  onModuleInit(): void {
    for (const definition of DOSSIER_STAGE_DEFINITIONS) this.stages.register(definition);
    this.handlers.register(DOSSIER_TASK_KIND, this.dossierTasks.dossierHandler);
    this.handlers.register(GLOSSARY_TASK_KIND, this.dossierTasks.glossaryHandler);
    this.kinds.register('dossier', this.dossierTasks);
    for (const definition of TRANSLATE_STAGE_DEFINITIONS) this.stages.register(definition);
    for (const definition of CHECK_STAGE_DEFINITIONS) this.stages.register(definition);
    for (const definition of METADATA_STAGE_DEFINITIONS) this.stages.register(definition);
    for (const definition of FINAL_CHECK_STAGE_DEFINITIONS) this.stages.register(definition);
    this.handlers.register(COMPARE_TASK_KIND, this.compareTasks.handler);
    this.kinds.register('compare', this.compareTasks);
    this.handlers.register(TRANSLATION_RUN_TASK_KIND, this.runTasks.handler);
    this.kinds.register('translation_run', this.runTasks);
    this.handlers.register(TRANSLATION_RETRY_KIND, this.retryTasks.handler);
    this.kinds.register('translation_retry', this.retryTasks);
  }
}
