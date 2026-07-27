import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ContributorIdentityConfidenceDto, ContributorRoleDto } from './create-contributor.dto';

export class QueryContributorsDto {
  @ApiPropertyOptional({ description: 'Search term for name or pseudonym' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: ContributorRoleDto, description: 'Filter by role' })
  @IsOptional()
  @IsEnum(ContributorRoleDto)
  role?: ContributorRoleDto;

  @ApiPropertyOptional({
    enum: ContributorIdentityConfidenceDto,
    description: 'Filter by identity confidence',
  })
  @IsOptional()
  @IsEnum(ContributorIdentityConfidenceDto)
  identityConfidence?: ContributorIdentityConfidenceDto;

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
