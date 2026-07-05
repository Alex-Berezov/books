import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

class ImportTagTranslationDto {
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
  @IsString()
  canonicalUrl?: string;

  @ApiPropertyOptional({ default: 'index, follow' })
  @IsOptional()
  @IsString()
  robots?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  faq?: Array<{ question: string; answer: string }>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedTagSlugs?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedGenreSlugs?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedCategorySlugs?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedCollectionSlugs?: string[];
}

export class ImportTagDto {
  @ApiProperty({ example: 'aestheticism' })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  key: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug: string;

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
      en: { name: 'Aestheticism', slug: 'aestheticism' },
    },
  })
  @IsObject()
  translations: Record<string, ImportTagTranslationDto>;
}
