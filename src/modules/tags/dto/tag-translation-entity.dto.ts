import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят скалярные колонки модели `TagTranslation`
 * (`prisma/schema.prisma`) один в один, БЕЗ связей `tag`/`seo`.
 *
 * Это форма, в которой перевод попадает в `tag.translation` на
 * `GET /tags/:slug/books` (`TagsService.versionsByTagSlug` берёт запись через
 * `trans as TagTranslation` — приведение к базовой модели специально режет
 * связи, которые в этот момент фактически загружены). Если нужен перевод со
 * связью `seo`, см. `TagTranslationEntityDto` ниже.
 */
export class TagTranslationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tagId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  h1?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaTitle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogTitle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogImageUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogImageAlt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  canonicalUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'index, follow' })
  robots?: string | null;

  @ApiProperty({ default: true })
  indexable!: boolean;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { question: { type: 'string' }, answer: { type: 'string' } },
    },
    nullable: true,
    description: 'Json column. Shape held by `TagFaqDto` on `CreateTagTranslationDto.faq`.',
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq?: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description:
      'Json column. Shape held by `@IsString({ each: true })` on `CreateTagTranslationDto.relatedTagSlugs`.',
    example: ['aestheticism', 'beauty'],
  })
  relatedTagSlugs?: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description:
      'Json column. Shape held by `@IsString({ each: true })` on `CreateTagTranslationDto.relatedGenreSlugs`.',
    example: ['classic-literature', 'philosophical-fiction'],
  })
  relatedGenreSlugs?: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description:
      'Json column. Shape held by `@IsString({ each: true })` on `CreateTagTranslationDto.relatedCategorySlugs`.',
    example: ['classic-literature', 'victorian-literature'],
  })
  relatedCategorySlugs?: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description:
      'Json column. Shape held by `@IsString({ each: true })` on `CreateTagTranslationDto.relatedCollectionSlugs`.',
    example: ['short-reads', 'feel-good-books'],
  })
  relatedCollectionSlugs?: unknown;

  @ApiProperty({ default: 0 })
  bookCount!: number;

  @ApiProperty({ default: true })
  autoIndexable!: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true })
  seoId?: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/**
 * `TagTranslationDto` плюс раскрытая связь `seo` — форма, которую
 * `TagsService.createTranslation`/`updateTranslation` возвращают через
 * `include: { seo: true }`.
 *
 * Используется на `POST /tags/:id/translations`, `GET /tags/:id/translations`
 * и `PATCH /tags/:id/translations/:language`.
 */
export class TagTranslationEntityDto extends TagTranslationDto {
  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo?: SeoResponseDto | null;
}
