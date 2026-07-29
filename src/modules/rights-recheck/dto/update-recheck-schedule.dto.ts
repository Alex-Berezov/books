import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RECHECK_MAX_INTERVAL_DAYS, RECHECK_MIN_INTERVAL_DAYS } from '../rights-recheck.constants';
import { RightsRecheckPolicy } from '../rights-recheck-interface';

export class UpdateRecheckScheduleDto {
  @ApiPropertyOptional({ nullable: true, description: 'null clears the planned date' })
  @IsOptional()
  @IsISO8601()
  nextReviewAt?: string | null;

  @ApiPropertyOptional({ enum: RightsRecheckPolicy })
  @IsOptional()
  @IsEnum(RightsRecheckPolicy)
  recheckPolicy?: RightsRecheckPolicy;

  @ApiPropertyOptional({ minimum: RECHECK_MIN_INTERVAL_DAYS, maximum: RECHECK_MAX_INTERVAL_DAYS })
  @IsOptional()
  @IsInt()
  @Min(RECHECK_MIN_INTERVAL_DAYS)
  @Max(RECHECK_MAX_INTERVAL_DAYS)
  recheckIntervalDays?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsISO8601()
  recheckPausedUntil?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  recheckPauseReasonRu?: string | null;
}
