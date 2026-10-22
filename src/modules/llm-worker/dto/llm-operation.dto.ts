import { ApiProperty } from '@nestjs/swagger';
import { LlmOperationKind, LlmOperationStatus, LlmPauseReason } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';

/** Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7). */
export class LlmOperationDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: LlmOperationKind, enumName: 'LlmOperationKind' })
  kind!: LlmOperationKind;

  @ApiProperty({ enum: LlmOperationStatus, enumName: 'LlmOperationStatus' })
  status!: LlmOperationStatus;

  @ApiProperty({ enum: LlmPauseReason, enumName: 'LlmPauseReason', nullable: true })
  pauseReason!: LlmPauseReason | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  bookVersionId!: string | null;

  @ApiProperty(LLM_MONEY_PROPERTY)
  limitUsd!: string;

  @ApiProperty(LLM_MONEY_PROPERTY)
  reservedUsd!: string;

  @ApiProperty(LLM_MONEY_PROPERTY)
  spentUsd!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}
