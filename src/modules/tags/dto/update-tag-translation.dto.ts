import { ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';
import { SeoInputDto } from '../../pages/dto/seo-input.dto';
// Один класс на оба DTO: Swagger именует схему по имени класса, и второе объявление
// с тем же именем молча вытесняло первое из `components.schemas` (`LEGACY-016`).
import { TagFaqDto } from './create-tag-translation.dto';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';

export class UpdateTagTranslationDto {
  @ApiPropertyOptional({ enum: Object.values(Language) })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({ description: 'Localized tag name' })
  // 🔴 `LEGACY-363`. Колонки `name` и `slug` перевода — `NOT NULL`
  // (`prisma/schema.prisma`), а сервис кладёт значение в `data` без фильтра. Поэтому
  // у этих двух полей нет `@IsOptional()`: он пропустил бы `null` мимо `@IsString()`,
  // и `{"name": null}` уронил бы Prisma пятисотым вместо штатного 400. Остальные поля
  // ниже — описательные (`description`, `h1`, `metaTitle`, `faq` и прочие) — стоят над
  // nullable-колонками, и `null` в них валидатор пропускает.
  // ⚠️ Очисткой это становится не везде: `TagsService.updateTranslation` с 29.09.2026
  // (`LEGACY-422`, `T69`) пишет девять полей контента, с 30.09.2026 (`T73`) и `indexable`,
  // а `robots` и `canonicalUrl` по-прежнему не переносит в `data` — присланное значение
  // теряется молча (решение арбитра 30.09.2026). Найдено ревью 13.09.2026.
  // Решение арбитра 13.09.2026.
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ description: 'Localized tag slug', pattern: SLUG_PATTERN })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ description: 'HTML description for the tag page' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  description?: string | null;

  @ApiPropertyOptional({ description: 'H1 heading for the tag page', type: String, nullable: true })
  @IsOptional()
  @IsString()
  h1?: string | null;

  @ApiPropertyOptional({ description: 'Short description for cards/lists' })
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional({ description: 'Meta title for SEO', type: String, nullable: true })
  @IsOptional()
  @IsString()
  metaTitle?: string | null;

  @ApiPropertyOptional({ description: 'Meta description for SEO' })
  @IsOptional()
  @IsString()
  metaDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph title', type: String, nullable: true })
  @IsOptional()
  @IsString()
  ogTitle?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph description' })
  @IsOptional()
  @IsString()
  ogDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image URL' })
  @IsOptional()
  @IsAbsoluteHttpUrl()
  ogImageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image alt text', type: String, nullable: true })
  @IsOptional()
  @IsString()
  ogImageAlt?: string | null;

  @ApiPropertyOptional({ description: 'Canonical URL' })
  @IsOptional()
  @IsAbsoluteHttpUrl()
  canonicalUrl?: string;

  @ApiPropertyOptional({ description: 'Robots directive', example: 'index, follow' })
  @IsOptional()
  @IsString()
  robots?: string;

  // `TagTranslation.indexable` — тоже `NOT NULL` (`prisma/schema.prisma:798`), поэтому
  // условие такое же, как у `name` и `slug` выше: с 30.09.2026 (`LEGACY-422`, `T73`)
  // `TagsService.updateTranslation` пишет поле в `data`, и `@IsOptional()` пропустил бы
  // `null` до пятисотого. Найдено ревью `books-tests` 13.09.2026.
  @ApiPropertyOptional({ description: 'Whether this tag should be indexed', default: true })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({
    description: 'FAQ items',
    type: [TagFaqDto],
    nullable: true,
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TagFaqDto)
  faq?: TagFaqDto[] | null;

  @ApiPropertyOptional({
    description: 'Related tag slugs',
    type: [String],
    example: ['aestheticism', 'beauty'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedTagSlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related genre/category slugs',
    type: [String],
    example: ['classic-literature', 'philosophical-fiction'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedGenreSlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related category slugs',
    type: [String],
    example: ['classic-literature', 'victorian-literature'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedCategorySlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related collection slugs',
    type: [String],
    example: ['short-reads', 'feel-good-books'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedCollectionSlugs?: string[];

  @ApiPropertyOptional({ description: 'SEO metadata', type: SeoInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto;
}
