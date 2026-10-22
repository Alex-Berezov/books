import { Injectable } from '@nestjs/common';
import { LlmOperation, LlmOperationKind, Prisma } from '@prisma/client';
import { EnqueueTaskInput } from './llm-task.service';

/**
 * Что знает модуль конвейера о своих операциях: какую задачу ставить на «продолжить» и что
 * сделать после отмены. Вид без записи «продолжить» не умеет - 409
 * `LLM_OPERATION_NOT_RESUMABLE` (решение арбитра `F05 | F05-2`, В5).
 */
export interface LlmOperationKindHandler {
  /** Задача шага для «продолжить»; `null` - продолжать нечего. Статус операции не пишет. */
  resumeTask(operation: LlmOperation): Promise<EnqueueTaskInput | null>;
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
