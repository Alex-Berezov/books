import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ContributorRole } from '../../persons/person-interface';

export class QueryContributorsDto {
  @ApiPropertyOptional({ description: 'Search term for name or authority identifiers' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: ContributorRole, description: 'Filter by contributor role' })
  @IsOptional()
  @IsEnum(ContributorRole)
  role?: ContributorRole;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
