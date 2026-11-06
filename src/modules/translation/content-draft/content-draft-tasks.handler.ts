import { Injectable } from '@nestjs/common';
import { ContentDraft, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import {
  DRAFT_CANCELLED,
  DRAFT_INPUT_MISSING,
  RETIRED_DRAFT_KINDS,
} from './content-draft.constants';
import { ContentDraftService, draftTaskInput } from './content-draft.service';
import { summaryWriteTaskInput, SummaryWriteHandler } from '../summary-write/summary-write.handler';
import { runTaskPayload } from '../draft-quality/run-regen';
import {
  AnalysisWriteHandler,
  analysisWriteTaskInput,
} from '../analysis-write/analysis-write.handler';

/** Операция заведена запуском перевода (автозапуск и ход `F06-5`); перегенерации его не несут. */
const isRunOperation = (op: Pick<LlmOperation, 'translationRunId'>): boolean =>
  typeof op.translationRunId === 'string';

/**
 * Обработчик операций `draft`: «Continue», отмена и отказ ходов пересказа и анализа и их
 * перегенераций. Своих шагов у задачи `content_draft` больше нет: заготовки сняты все (Summary
 * `F05-10` в `F06-3`, Analysis `F05-11` в `F07-3a`) - строящаяся строка снятого вида, чья задача
 * пришла до дренажа при старте, отбрасывается тем же путём (А1; решение арбитра `F07 | F07-3`).
 */
@Injectable()
export class ContentDraftTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly drafts: ContentDraftService,
    private readonly summaryWrite: SummaryWriteHandler,
    private readonly analysisWrite: AnalysisWriteHandler,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task) => this.run(task),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  /**
   * «Continue» операции `draft`: ход пересказа (`F06-2`) и ход анализа (`F07-1b`) - своей задачей,
   * строка снятого вида - задачей, которая её отбросит; строки с этой операцией нет - это операция
   * перегенерации текста или блока хода (решение арбитра `F06 | F06-2`, Р2) или автозапуска
   * (`F06-5`): у перегенерации `translationRunId` нет никогда, автозапуск закрывает свою операцию
   * сам - продолжать нечего (решение арбитра `F06 | F06-5`, Р4).
   */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const row = await this.prisma.contentDraft.findUnique({ where: { operationId: op.id } });
    if (!row) return isRunOperation(op) ? [] : this.regenResume(op);
    if (row.status !== 'building') return [];
    // Ход анализа свой задачей: задача заготовки отбила бы строку чужого вида (Л1 `F07-1a`).
    if (row.kind === 'analysis_write') return [analysisWriteTaskInput(row, row.operationId)];
    return row.kind === 'summary_write'
      ? [summaryWriteTaskInput(row, row.operationId)]
      : [draftTaskInput(row)];
  }

  /** Перегенерация хода: блок ищется у обоих видов хода по отметке операции. */
  private async regenResume(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const summary = await this.summaryWrite.regenResume(op);
    return summary.length > 0 ? summary : this.analysisWrite.regenResume(op);
  }

  /**
   * Отмена со страницы операций (не «discard»): ход `failed` с причиной; операция
   * перегенерации снимает отметку у своего текста, ход остаётся `ready` (Р2).
   */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.contentDraft.updateMany({
      where: { operationId: op.id, status: 'building' },
      data: { status: 'failed', failedReason: DRAFT_CANCELLED },
    });
    // Операция запуска (ход и автозапуск `F06-5`) - не перегенерация: отметок текста у неё нет (Р4).
    if (!isRunOperation(op)) {
      await this.summaryWrite.onRegenCancelled(op, tx);
      await this.analysisWrite.onRegenCancelled(op, tx);
    }
  }

  private async run(task: LlmTask): Promise<LlmTaskStepResult> {
    const id = runTaskPayload(task).draftId;
    const row = id ? await this.prisma.contentDraft.findUnique({ where: { id } }) : null;
    // Строки нет (версию удалили - каскад) или она уже не строится: делать нечего.
    if (!row || row.status !== 'building') {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    // Снятый вид (окно выката до дренажа при старте): отбросить, а не уронить (А1, L-041).
    if ((RETIRED_DRAFT_KINDS as readonly string[]).includes(row.kind)) {
      await this.drafts.discardRetired(row);
      return { kind: 'done' };
    }
    // Ход своего вида задачей заготовки не строится (Л1 `F07-1a`): окончательный отказ.
    return this.fail(row, DRAFT_INPUT_MISSING);
  }

  /** Окончательный отказ: операция `failed`, строка `failed` с причиной одной записью. */
  private async fail(row: ContentDraft, reason: string): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(row.operationId, async (tx) => {
      await tx.contentDraft.updateMany({
        where: { id: row.id, status: 'building' },
        data: { status: 'failed', failedReason: reason },
      });
    });
    return { kind: 'done' };
  }

  /** Деньги и отказ провайдеров - пауза своей причиной, прочее - `STEP_FAILED` (продолжаемо). */
  private async onFailed(task: LlmTask, reason: string): Promise<void> {
    await this.tasks.pauseOperation(task.operationId, PAUSE_BY_FAILURE[reason] ?? 'STEP_FAILED');
  }
}
