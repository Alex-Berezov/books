import { ContentDraft } from '@prisma/client';
import type { LlmTaskService } from '../../llm-worker/llm-task.service';
import type { LlmTaskStepResult } from '../../llm-worker/llm-task.types';

/**
 * Концы шага хода пересказа и анализа: общие для двух обработчиков (`T178`, без смены поведения).
 */

/** Строка хода больше не принимает запись этой операции: цикл качества обрывается без вызовов. */
export class RunGone extends Error {
  constructor() {
    super('The draft run no longer takes this step');
    this.name = 'RunGone';
  }
}

type Tasks = Pick<LlmTaskService, 'completeOperation' | 'failOperation'>;

/** Шаг, который строка уже не принимает: операция закрывается (уже закрытая - без изменений). */
export async function stepGone(tasks: Tasks, operationId: string): Promise<LlmTaskStepResult> {
  await tasks.completeOperation(operationId);
  return { kind: 'done' };
}

/** Конец хода: `ready` вместе с концом операции; операция не идёт - ждёт «Continue». */
export async function finishRun(tasks: Tasks, row: ContentDraft): Promise<LlmTaskStepResult> {
  await tasks.completeOperation(row.operationId, async (tx) => {
    await tx.contentDraft.updateMany({
      where: { id: row.id, status: 'building', operationId: row.operationId },
      data: { status: 'ready', waitingFor: null },
    });
  });
  return { kind: 'done' };
}

/** Окончательный отказ хода: операция `failed`, ход `failed` с причиной одной записью. */
export async function failRun(
  tasks: Tasks,
  row: ContentDraft,
  reason: string,
): Promise<LlmTaskStepResult> {
  await tasks.failOperation(row.operationId, async (tx) => {
    await tx.contentDraft.updateMany({
      where: { id: row.id, status: 'building' },
      data: { status: 'failed', failedReason: reason },
    });
  });
  return { kind: 'done' };
}
