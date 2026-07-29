import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RightsRecheckResolution } from '../rights-recheck-interface';

export class CompleteRecheckTaskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notesRu?: string;

  @ApiPropertyOptional({ description: 'The review that closed this task' })
  @IsOptional()
  @IsUUID()
  completedReviewId?: string;

  @ApiPropertyOptional({
    enum: RightsRecheckResolution,
    default: RightsRecheckResolution.MANUALLY_CLOSED,
  })
  @IsOptional()
  @IsEnum(RightsRecheckResolution)
  resolution?: RightsRecheckResolution;
}
