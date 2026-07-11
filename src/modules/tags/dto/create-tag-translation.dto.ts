import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { SeoInputDto } from '../../pages/dto/seo-input.dto';

export class TagFaqDto {
  @ApiProperty({ description: 'Question text' })
  @IsString()
  question!: string;

  @ApiProperty({ description: 'Answer text' })
  @IsString()
  answer!: string;
}

export class CreateTagTranslationDto {
  @ApiProperty({ enum: Object.values(Language) })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Localized tag name' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'Localized tag slug', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiPropertyOptional({ description: 'HTML description for the tag page' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: 'H1 heading for the tag page' })
  @IsOptional()
  @IsString()
  h1?: string;

  @ApiPropertyOptional({ description: 'Short description for cards/lists' })
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional({ description: 'Meta title for SEO' })
  @IsOptional()
  @IsString()
  metaTitle?: string;

  @ApiPropertyOptional({ description: 'Meta description for SEO' })
  @IsOptional()
  @IsString()
  metaDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph title' })
  @IsOptional()
  @IsString()
  ogTitle?: string;

  @ApiPropertyOptional({ description: 'Open Graph description' })
  @IsOptional()
  @IsString()
  ogDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image URL' })
  @IsOptional()
  @IsString()
  ogImageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image alt text' })
  @IsOptional()
  @IsString()
  ogImageAlt?: string;

  @ApiPropertyOptional({ description: 'Canonical URL' })
  @IsOptional()
  @IsString()
  canonicalUrl?: string;

  @ApiPropertyOptional({ description: 'Robots directive', example: 'index, follow' })
  @IsOptional()
  @IsString()
  robots?: string;

  @ApiPropertyOptional({ description: 'Whether this tag should be indexed', default: true })
  @IsOptional()
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({
    description: 'FAQ items',
    type: [TagFaqDto],
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TagFaqDto)
  faq?: TagFaqDto[];

  @ApiPropertyOptional({
    description: 'Related tag slugs',
    type: [String],
    example: ['aestheticism', 'beauty'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedTagSlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related genre/category slugs',
    type: [String],
    example: ['classic-literature', 'philosophical-fiction'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedGenreSlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related category slugs',
    type: [String],
    example: ['classic-literature', 'victorian-literature'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedCategorySlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related collection slugs',
    type: [String],
    example: ['short-reads', 'feel-good-books'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedCollectionSlugs?: string[];

  @ApiPropertyOptional({ description: 'SEO metadata', type: SeoInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto;
}
