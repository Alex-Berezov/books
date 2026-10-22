import { LlmOperation } from '@prisma/client';
import { moneyUsd } from '../llm/dto/llm-money';
import { LlmOperationDto } from './dto/llm-operation.dto';

export function toOperationDto(op: LlmOperation): LlmOperationDto {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    pauseReason: op.pauseReason,
    bookVersionId: op.bookVersionId,
    limitUsd: moneyUsd(op.limitUsd),
    reservedUsd: moneyUsd(op.reservedUsd),
    spentUsd: moneyUsd(op.spentUsd),
    createdAt: op.createdAt.toISOString(),
    updatedAt: op.updatedAt.toISOString(),
  };
}
