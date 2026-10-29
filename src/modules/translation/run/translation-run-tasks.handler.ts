import { Injectable } from '@nestjs/common';
import { LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import { metadataStateOf } from '../metadata/metadata-state';
import { runTaskInput } from './translation-run.service';
import { RUN_LANGUAGE_UNFINISHED, UNRESUMABLE_REASONS } from './translation-run.constants';
import { staleClosure } from './stale-closure';
import {
  CLEAR_STOP,
  StaleDecisionChangedError,
  runLanguageIdOf,
  RunStepSupportService,
} from './run-step-support.service';
import { ChunkRunStepsService } from './chunk-run-steps.service';
import { ContextRunStepsService } from './context-run-steps.service';
import { MetadataDraftRunStepsService } from './metadata-draft-run-steps.service';

/**
 * Задачи языка запуска перевода (`F05-4`, шаги 4-6): «продолжить», отмена, провал задачи и выбор
 * входного шага. Шаг за раз: досье и глоссарий (`ContextRunStepsService`) → главы и куски
 * (`ChunkRunStepsService`); дальше ход передают сами классы шагов по цепочке: сборка глав
 * (`AssemblyRunStepsService`) → итоговая проверка (`FinalCheckRunStepsService`) → `metadata`
 * и черновик (`MetadataDraftRunStepsService`); обработчик сам зовёт черновик, когда ответ `metadata`
 * уже принят. Общее - `RunStepSupportService`. Модели этапов - из снимка
 * операции запуска или `stageModels` (решение арбитра `F05 | F05-4a`, В1).
 */
@Injectable()
export class TranslationRunTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly support: RunStepSupportService,
    private readonly context: ContextRunStepsService,
    private readonly chunks: ChunkRunStepsService,
    private readonly metadataDraft: MetadataDraftRunStepsService,
  ) {}

  /** С `DOSSIER_STALE` запуск не продолжают (Р13) - условием записи «продолжить». */
  readonly unresumableReasons = UNRESUMABLE_REASONS;

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  /**
   * «Продолжить» - задача на каждый недоделанный язык (решение арбитра `F05 | F05-4`). После
   * `DOSSIER_STALE` продолжать нечего (Р13): куски на старом досье, выход - отмена или новый
   * запуск; иначе языки в середине главы переводили бы дальше по устаревшему досье за деньги.
   * Исходник правили, пока запуск стоял на другой паузе, - сверка здесь же (`tech.md` §2а:
   * «не совпал при продолжении запуска - запуск встаёт»): причина паузы меняется на
   * `DOSSIER_STALE`, задач нет, «продолжить» отвечает 409.
   */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    if (op.pauseReason !== null && UNRESUMABLE_REASONS.includes(op.pauseReason)) return [];
    const run = await this.prisma.translationRun.findUnique({
      where: { operationId: op.id },
      include: { languages: { orderBy: { language: 'asc' } } },
    });
    if (!run || run.languages.length === 0) return [];
    const open = run.languages.filter((l) =>
      (RUN_LANGUAGE_UNFINISHED as readonly string[]).includes(l.status),
    );
    // Тупик Р13 - только если ни у одного языка нет живого черновика (`staleClosure`). Снимок
    // здесь - лишь повод попробовать тупик: решение принимается заново в транзакции смены
    // причины, под замком строки операции (её `UPDATE`). Черновик появился между снимком и
    // замком - смены нет (откат), «продолжить» идёт дальше. Иначе задачи ставятся всем открытым
    // языкам, а устаревшие закрывает `onResumed` - то же решение в транзакции «продолжить»;
    // задача закрытого языка ничего не делает (`run`: язык не в работе).
    if (
      run.dossierFingerprint !== null &&
      !staleClosure(open).hasLiveDraft &&
      (await this.support.isStale(run))
    ) {
      try {
        await this.tasks.repauseOperation(op.id, 'DOSSIER_STALE', async (tx) => {
          if ((await this.support.closeOnStale(tx, run.id)).hasLiveDraft)
            throw new StaleDecisionChangedError();
          await tx.translationRunLanguage.updateMany({
            where: { runId: run.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
            data: { ...CLEAR_STOP, reason: 'DOSSIER_STALE' },
          });
        });
        return [];
      } catch (error) {
        if (!(error instanceof StaleDecisionChangedError)) throw error;
      }
    }
    // Все языки доделаны, а операция на паузе (пауза пришла вместе с последним шагом): шаг
    // любого языка закроет операцию.
    const languages = open.length > 0 ? open : run.languages.slice(0, 1);
    return languages.map((l) => runTaskInput(l.id, l.language, op.id));
  }

  /** «Продолжить»: причины остановки недоделанных языков сбрасываются той же транзакцией. */
  async onResumed(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    // Строка операции уже под замком записи «продолжить» (`resumeOperation`): решение и его
    // исполнение - через `tx`, тем же снимком, что и шаги, которые ждут этот замок.
    const run = await tx.translationRun.findUnique({ where: { operationId: op.id } });
    if (run && run.dossierFingerprint !== null && (await this.support.isStale(run, tx))) {
      const decision = await this.support.closeOnStale(tx, run.id);
      // Живого черновика под замком уже нет (его удалили после снимка `resumeTasks`), а языки
      // ждут: продолжать их по устаревшему исходнику нельзя (Р13) - отказ, транзакция откатывается,
      // следующее «продолжить» поставит тупик.
      if (!decision.hasLiveDraft && decision.waiting.length > 0) {
        throw llmTaskConflict(
          'LLM_OPERATION_NOT_RESUMABLE',
          'The source changed and no language writes a draft: the run cannot be continued',
        );
      }
    }
    await tx.translationRunLanguage.updateMany({
      where: { run: { operationId: op.id }, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: CLEAR_STOP,
    });
  }

  /**
   * Отменённый запуск: недоделанные языки - `cancelled` в той же транзакции. Куски остаются.
   * Операции досье и глоссария, заведённые ради запуска, не отменяются: их ждут и другие
   * (Р20, решение арбитра `F05 | F05-4a`, В5).
   */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.translationRunLanguage.updateMany({
      where: { run: { operationId: op.id }, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { status: 'cancelled' },
    });
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = runLanguageIdOf(task);
    const lang = id
      ? await this.prisma.translationRunLanguage.findUnique({
          where: { id },
          include: { run: { include: { operation: { select: { settingsSnapshot: true } } } } },
        })
      : null;
    // Строки нет (версию удалили - каскад): переводить нечего; уцелевшие языки - `failed` (В6).
    if (!lang) {
      await this.tasks.failOperation(task.operationId, async (tx) => {
        await tx.translationRunLanguage.updateMany({
          where: {
            run: { operationId: task.operationId },
            status: { in: [...RUN_LANGUAGE_UNFINISHED] },
          },
          data: { status: 'failed' },
        });
      });
      return { kind: 'done' };
    }
    if (!(RUN_LANGUAGE_UNFINISHED as readonly string[]).includes(lang.status)) {
      await this.support.completeIfFinished(lang.run);
      return { kind: 'done' };
    }
    if (lang.status === 'pending') {
      await this.prisma.translationRunLanguage.updateMany({
        where: { id: lang.id, status: 'pending' },
        data: { status: 'running' },
      });
    }
    if (!lang.run.dossierId || !lang.glossaryId) return this.context.awaitContext(lang);
    // Черновик создан - дальше только его главы: шаги перевода и сборки исходник уже не сверяют
    // (правка исходника после создания версии не ставит язык на `DOSSIER_STALE`, 6b).
    // Удалённый черновик (`draftCreatedAt` без ссылки) - туда же: `DRAFT_DELETED` раньше сверок глав.
    const metadata =
      lang.bookVersionId === null && lang.draftCreatedAt === null
        ? null
        : metadataStateOf(lang.metadata)?.result;
    if (metadata) return this.metadataDraft.draftStep(lang, ctx, metadata);
    if (lang.chapterNumber === null) return this.chunks.startChapter(lang, null, ctx);
    return this.chunks.chapterStep(lang, lang.chapterNumber, ctx);
  }

  private async onFailed(task: LlmTask, reason: string): Promise<void> {
    const id = runLanguageIdOf(task);
    await this.tasks.pauseOperation(
      task.operationId,
      PAUSE_BY_FAILURE[reason] ?? 'STEP_FAILED',
      id
        ? async (tx) => {
            await tx.translationRunLanguage.updateMany({ where: { id }, data: { reason } });
          }
        : undefined,
    );
  }
}
