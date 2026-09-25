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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';

export class ImportTagTranslationDto {
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
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
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

  // `TagTranslation.indexable` — `NOT NULL` (`prisma/schema.prisma:793`), поэтому `null`
  // отбивается валидатором, а не Prisma (`LEGACY-363`, `LEGACY-401`, по образцу
  // `create-tag-translation.dto.ts`).
  @ApiPropertyOptional({ default: true })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  indexable?: boolean;

  // `faq`/`related*Slugs` — `Json?` (`prisma/schema.prisma:794-798`), но голый `null` Prisma
  // для Json-колонки не принимает («Provide `Prisma.DbNull`») — `buildTagTranslationData`
  // (`import.service.ts`) пишет значение как есть, сентинела не расставляет. `@ValidateIf`
  // превращает это в понятный 400 вместо необработанного отказа Prisma (`LEGACY-401`).
  @ApiPropertyOptional({ type: [FaqItemDto] })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq?: FaqItemDto[];

  @ApiPropertyOptional({ type: [String] })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  relatedTagSlugs?: string[];

  @ApiPropertyOptional({ type: [String] })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  relatedGenreSlugs?: string[];

  @ApiPropertyOptional({ type: [String] })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  relatedCategorySlugs?: string[];

  @ApiPropertyOptional({ type: [String] })
  @ValidateIf((_o, value) => value !== undefined)
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
