import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreateTagDto {
  @ApiProperty({ description: 'Tag name', example: 'Motivation' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Tag slug', example: 'motivation', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({ description: 'Stable unique key', example: 'motivation', pattern: SLUG_PATTERN })
  @IsString()
  @MinLength(2)
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  key!: string;

  @ApiPropertyOptional({
    description: 'Whether the page is indexable by search engines',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({ description: 'Whether the tag is visible in public lists', default: true })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional({ description: 'Sort order in lists', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
