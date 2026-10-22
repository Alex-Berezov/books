import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmOperationDto } from './dto/llm-operation.dto';
import { toOperationDto } from './llm-operation.mapper';
import { LlmOperationKindRegistry } from './llm-operation-kind.registry';
import { LlmTaskService } from './llm-task.service';
import { llmTaskConflict } from './llm-worker.errors';

/**
 * «Отменить» и «продолжить» любой операции из админки (`F05-2`, шаг 8). Переходы - методами
 * `LlmTaskService` с общим порядком замков; что ставить на «продолжить» - знает модуль вида.
 */
@Injectable()
export class LlmOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly kinds: LlmOperationKindRegistry,
    private readonly llm: LlmService,
  ) {}

  async cancel(operationId: string): Promise<LlmOperationDto> {
    const op = await this.find(operationId);
    const kind = this.kinds.get(op.kind);
    const cancelled = await this.tasks.cancelOperation(
      op.id,
      kind?.onCancelled ? (tx) => kind.onCancelled!(op, tx) : undefined,
    );
    if (!cancelled) {
      throw llmTaskConflict('LLM_OPERATION_NOT_CANCELLABLE', 'LLM operation cannot be cancelled');
    }
    return toOperationDto(await this.find(op.id));
  }

  /**
   * «Продолжить» с необязательным новым лимитом: после `LIMIT_REACHED` без него шаг упрётся
   * в тот же лимит. Лимит не ниже потраченного и зарезервированного - иначе 400. Без ключа
   * OpenRouter - 503 `LLM_DISABLED`: задачу некому исполнить, операция висела бы `active`.
   * `alongside` - запись вызывающего (модели этапов запуска перевода) в той же транзакции.
   */
  async resume(
    operationId: string,
    limitUsd?: Prisma.Decimal,
    alongside?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<LlmOperationDto> {
    const op = await this.find(operationId);
    this.llm.assertEnabled();
    const kind = this.kinds.get(op.kind);
    const tasks = op.status === 'paused' ? await kind?.resumeTasks(op) : null;
    if (!tasks || tasks.length === 0) {
      throw llmTaskConflict('LLM_OPERATION_NOT_RESUMABLE', 'LLM operation cannot be resumed');
    }
    if (limitUsd && limitUsd.lt(op.spentUsd.add(op.reservedUsd))) {
      throw new BadRequestException('limitUsd must not be below spentUsd + reservedUsd');
    }
    await this.tasks.resumeOperation(
      op.id,
      tasks,
      limitUsd,
      async (tx) => {
        await kind?.onResumed?.(op, tx);
        await alongside?.(tx);
      },
      kind?.unresumableReasons ?? [],
    );
    return toOperationDto(await this.find(op.id));
  }

  private async find(id: string): Promise<LlmOperation> {
    const op = await this.prisma.llmOperation.findUnique({ where: { id } });
    if (!op) throw new NotFoundException('LLM operation not found');
    return op;
  }
}
