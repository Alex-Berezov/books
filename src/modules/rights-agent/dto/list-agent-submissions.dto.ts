import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { RightsAgentSubmissionStatus } from '../rights-agent-interface';

export class ListAgentSubmissionsDto {
  @ApiPropertyOptional({ enum: RightsAgentSubmissionStatus })
  @IsOptional()
  @IsEnum(RightsAgentSubmissionStatus)
  status?: RightsAgentSubmissionStatus;

  @ApiPropertyOptional({ description: 'Filter by intake (global list only)' })
  @IsOptional()
  @IsUUID()
  intakeId?: string;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
