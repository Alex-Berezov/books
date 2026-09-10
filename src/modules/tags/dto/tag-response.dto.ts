import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import { Language } from '@prisma/client';

export class TagTranslationResponse {
  @ApiProperty({ enum: Language })
  language: Language;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ type: String })
  slug: string;

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

  @ApiPropertyOptional({ type: Boolean, default: true })
  indexable?: boolean;

  @ApiPropertyOptional({
    type: [FaqItemDto],
    nullable: true,
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq?: FaqItemDto[] | null;

  @ApiPropertyOptional({ type: [String], example: ['aestheticism', 'beauty'] })
  relatedTagSlugs?: unknown;

  @ApiPropertyOptional({
    type: [String],
    example: ['classic-literature', 'philosophical-fiction'],
  })
  relatedGenreSlugs?: unknown;

  @ApiPropertyOptional({ type: [String], example: ['classic-literature', 'victorian-literature'] })
  relatedCategorySlugs?: unknown;

  @ApiPropertyOptional({ type: [String], example: ['short-reads', 'feel-good-books'] })
  relatedCollectionSlugs?: unknown;

  @ApiPropertyOptional({
    description: 'Cached number of published books in this language.',
  })
  bookCount?: number;

  @ApiPropertyOptional({
    description:
      'Automatic indexability derived from bookCount with hysteresis (close <=2, open >=5). Drives meta robots, the sitemap and internal linking alike.',
  })
  autoIndexable?: boolean;
}

export class TagResponse {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ type: String })
  slug: string;

  @ApiProperty({ type: String })
  key: string;

  /**
   * Три флага ниже и `booksCount` объявлены обязательными, а не необязательными:
   * `TagsService.list` кладёт каждый из них в **каждый** элемент выдачи
   * безусловно — `indexable: item.indexable ?? true`, `isVisible: ... ?? true`,
   * `sortOrder: ... ?? 0`, `booksCount: countMap.get(item.id) || 0`
   * (`tags.service.ts:111-115`). Другого источника у `data[]` нет: и `GET /tags`,
   * и `GET /{lang}/tags` идут через тот же `list`.
   *
   * 🔴 `booksCount` как необязательное поле останавливало машинную сверку
   * рукописных типов фронта со схемой на `GET /{lang}/tags` (`LEGACY-374`):
   * фронт объявляет `TagListItem.booksCount: number`, схема отдавала
   * `number | undefined`, и маршрут не попадал в снимок покрытия — то есть
   * не сверялся вовсе.
   */
  @ApiProperty({ type: Boolean, default: true })
  indexable!: boolean;

  @ApiProperty({ type: Boolean, default: true })
  isVisible!: boolean;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;

  @ApiProperty({ type: [TagTranslationResponse] })
  translations: TagTranslationResponse[];

  @ApiProperty({ type: Number })
  booksCount!: number;

  @ApiPropertyOptional({
    description:
      'Cached per-language book count (TagTranslation.bookCount) for the requested ?lang. Undefined when lang is not passed or the tag has no translation for it.',
  })
  langBookCount?: number;

  @ApiPropertyOptional({
    description:
      'Automatic indexability (hysteresis state) for the requested ?lang. Mirrors what meta robots and the sitemap decide. Undefined when lang is not passed or the tag has no translation for it.',
  })
  autoIndexable?: boolean;
}

export class PaginationMeta {
  @ApiProperty({ type: Number })
  page: number;

  @ApiProperty({ type: Number })
  limit: number;

  @ApiProperty({ type: Number })
  total: number;

  @ApiProperty({ type: Number })
  totalPages: number;
}

export class PaginatedTagsResponse {
  @ApiProperty({ type: [TagResponse] })
  data: TagResponse[];

  @ApiProperty()
  meta: PaginationMeta;
}
