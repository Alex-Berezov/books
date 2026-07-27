import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Language } from '@prisma/client';
import { ContributorRole, PersonType } from '../person-interface';

export class QueryPersonsDto {
  @ApiPropertyOptional({
    description: 'Search term for name, sortName, translation, or authority identifiers',
  })
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: ContributorRole })
  @IsEnum(ContributorRole)
  @IsOptional()
  role?: ContributorRole;

  @ApiPropertyOptional({ enum: PersonType })
  @IsEnum(PersonType)
  @IsOptional()
  type?: PersonType;

  @ApiPropertyOptional({ enum: Language })
  @IsEnum(Language)
  @IsOptional()
  language?: Language;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number = 0;
}
