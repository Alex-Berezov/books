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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CategoryType } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';

export class ImportCategoryTranslationDto {
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

  // `faq` — `Json?` (`prisma/schema.prisma`), но голый `null` Prisma для Json-колонки
  // не принимает («Provide `Prisma.DbNull`») — `buildCategoryTranslationData`
  // (`import.service.ts`) пишет значение как есть, сентинела не расставляет. `@ValidateIf`
  // превращает это в понятный 400 вместо необработанного отказа Prisma (`LEGACY-401`).
  @ApiPropertyOptional({ type: [FaqItemDto] })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq?: FaqItemDto[];
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
