import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { CategoryType } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

class ImportCategoryTranslationDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  h1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogImageUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogImageAlt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  faq?: Array<{ question: string; answer: string }>;
}

export class ImportCategoryDto {
  @ApiProperty({ example: 'victorian-literature' })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  key: string;

  @ApiProperty({ enum: CategoryType })
  @IsEnum(CategoryType)
  type: CategoryType;

  @ApiPropertyOptional({ nullable: true, example: 'classic-literature' })
  @IsOptional()
  @IsString()
  parentKey?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiProperty({
    description: 'Translations keyed by language code',
    example: {
      en: { name: 'Victorian Literature', slug: 'victorian-literature' },
    },
  })
  @IsObject()
  translations: Record<string, ImportCategoryTranslationDto>;
}
