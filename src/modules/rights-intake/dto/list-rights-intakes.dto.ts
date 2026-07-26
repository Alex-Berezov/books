import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max, IsEnum, IsString, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { RightsIntakeStatus, RightsSourceProvider } from '@prisma/client';

export class ListRightsIntakesDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Filter by status', enum: RightsIntakeStatus })
  @IsOptional()
  @IsEnum(RightsIntakeStatus)
  status?: RightsIntakeStatus;

  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Filter by source provider', enum: RightsSourceProvider })
  @IsOptional()
  @IsEnum(RightsSourceProvider)
  sourceProvider?: RightsSourceProvider;

  @ApiPropertyOptional({ description: 'Filter by target language' })
  @IsOptional()
  @IsString()
  targetLanguage?: string;

  @ApiPropertyOptional({ description: 'Filter for intakes requiring action' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  attentionOnly?: boolean;

  @ApiPropertyOptional({ description: 'Include summary indicators in list response' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeSummary?: boolean;
}
