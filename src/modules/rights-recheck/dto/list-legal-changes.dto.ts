import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import {
  RightsLegalChangeStatus,
  RightsLegalChangeType,
  RightsRecheckSeverity,
} from '../rights-recheck-interface';

export class ListLegalChangesDto {
  @ApiPropertyOptional({ enum: RightsLegalChangeStatus })
  @IsOptional()
  @IsEnum(RightsLegalChangeStatus)
  status?: RightsLegalChangeStatus;

  @ApiPropertyOptional({ enum: RightsLegalChangeType })
  @IsOptional()
  @IsEnum(RightsLegalChangeType)
  changeType?: RightsLegalChangeType;

  @ApiPropertyOptional({ enum: RightsRecheckSeverity })
  @IsOptional()
  @IsEnum(RightsRecheckSeverity)
  severity?: RightsRecheckSeverity;

  @ApiPropertyOptional({ description: 'ISO-2 code; matched against jurisdictionCodes in memory' })
  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  countryCode?: string;

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
