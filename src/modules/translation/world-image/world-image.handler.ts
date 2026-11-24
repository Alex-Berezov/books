import { Injectable } from '@nestjs/common';
import { LlmTask } from '@prisma/client';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { WORLD_IMAGE_GENERATION_REMOVED } from './world-image.constants';

/**
 * Сливной обработчик задач `world_image` (`F08-11d-1`, решение арбитра `F08 | F08-11d` Q7):
 * генерация картинки снята, но задачи, поставленные до выката, ещё могут лежать в базе. Шаг модель
 * не зовёт и в сеть не ходит: операция - `failed` тем же переходом, что у прочих отказов шага
 * (`LlmTaskService.failOperation`), задача - `failed` с причиной `WORLD_IMAGE_GENERATION_REMOVED`.
 * Резерв бюджета шаг не берёт; резерв вызова, оборванного выкатом посреди прежней генерации,
 * снимает чистка исполнителя (`LlmBudgetService.releaseStaleCalls`). Операции на паузе (`paused`)
 * исполнитель не захватывает, их задач этот обработчик не видит: такие операции закрывает
 * администратор ручкой отмены операции (решение `F08 | F08-11d` Q11).
 */
@Injectable()
export class WorldImageHandler {
  constructor(private readonly tasks: LlmTaskService) {}

  readonly handler: LlmTaskHandler = {
    run: (task) => this.run(task),
    // Захваты исчерпаны или шаг бросил: операция закрывается так же.
    onFailed: async (task) => {
      await this.tasks.failOperation(task.operationId);
    },
  };

  private async run(task: LlmTask): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(task.operationId);
    return { kind: 'fail', reason: WORLD_IMAGE_GENERATION_REMOVED };
  }
}
