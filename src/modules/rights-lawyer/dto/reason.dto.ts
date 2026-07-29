import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { LAWYER_MIN_REASON_LENGTH } from '../rights-lawyer.constants';

/**
 * Four Phase 19 actions are irreversible from the editor's point of view and therefore all
 * require the same thing — a written reason. They share the shape but stay separate classes so
 * Swagger documents each endpoint with its own body name.
 */
class ReasonRuDto {
  @ApiProperty({ minLength: LAWYER_MIN_REASON_LENGTH, maxLength: 5000 })
  @IsString()
  @MinLength(LAWYER_MIN_REASON_LENGTH)
  @MaxLength(5000)
  reasonRu!: string;
}

export class WithdrawLawyerReviewDto extends ReasonRuDto {}

export class ArchiveOpinionDto extends ReasonRuDto {}

export class WaiveConditionDto extends ReasonRuDto {}

export class DeactivateLawyerDto extends ReasonRuDto {}

export class SatisfyConditionDto {
  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notesRu?: string;
}

export class AddLawyerReviewNoteDto {
  @ApiProperty({ minLength: 1, maxLength: 5000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  messageRu!: string;
}
