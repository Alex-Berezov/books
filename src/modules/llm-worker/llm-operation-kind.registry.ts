import { Injectable } from '@nestjs/common';
import { LlmOperation, LlmOperationKind, LlmPauseReason, Prisma } from '@prisma/client';
import { EnqueueTaskInput } from './llm-task.service';

/**
 * Что знает модуль конвейера о своих операциях: какую задачу ставить на «продолжить» и что
 * сделать после отмены. Вид без записи «продолжить» не умеет - 409
 * `LLM_OPERATION_NOT_RESUMABLE` (решение арбитра `F05 | F05-2`, В5).
 */
export interface LlmOperationKindHandler {
  /**
   * Задачи шага для «продолжить» - по одной на пару (у запуска перевода - на каждый язык,
   * решение арбитра `F05 | F05-4`); пусто - продолжать нечего. Статус операции не пишет; вид
   * вправе сменить причину стоящей паузы (`LlmTaskService.repauseOperation`), если продолжать
   * нельзя по новой причине (запуск перевода: исходник правили на другой паузе).
   */
  resumeTasks(operation: LlmOperation): Promise<EnqueueTaskInput[]>;
  /** Причины паузы, с которых вид не продолжает: отказ 409 условием записи «продолжить». */
  unresumableReasons?: readonly LlmPauseReason[];
  /**
   * Операцию продолжают: запись вида (сброс причин остановки) в транзакции «продолжить» -
   * откатывается вместе с ней.
   */
  onResumed?(operation: LlmOperation, tx: Prisma.TransactionClient): Promise<void>;
  /** Операцию отменяют: строки, которые она строила, закрываются в той же транзакции. */
  onCancelled?(operation: LlmOperation, tx: Prisma.TransactionClient): Promise<void>;
}

@Injectable()
export class LlmOperationKindRegistry {
  private readonly handlers = new Map<LlmOperationKind, LlmOperationKindHandler>();

  register(kind: LlmOperationKind, handler: LlmOperationKindHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`LLM operation kind "${kind}" is already registered`);
    }
    this.handlers.set(kind, handler);
  }

  get(kind: LlmOperationKind): LlmOperationKindHandler | undefined {
    return this.handlers.get(kind);
  }
}
