import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class UpdateTagDto {
  @ApiPropertyOptional({ description: 'Tag name' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ description: 'Tag slug', pattern: SLUG_PATTERN })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ description: 'Stable unique key', pattern: SLUG_PATTERN })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  key?: string;

  @ApiPropertyOptional({ description: 'Whether the page is indexable by search engines' })
  @IsOptional()
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({ description: 'Whether the tag is visible in public lists' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional({ description: 'Sort order in lists' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
