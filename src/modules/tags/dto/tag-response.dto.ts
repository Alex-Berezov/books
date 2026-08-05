import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';

export class TagTranslationResponse {
  @ApiProperty({ enum: Language })
  language: Language;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiPropertyOptional()
  description?: string | null;

  @ApiPropertyOptional()
  h1?: string | null;

  @ApiPropertyOptional()
  shortDescription?: string | null;

  @ApiPropertyOptional()
  metaTitle?: string | null;

  @ApiPropertyOptional()
  metaDescription?: string | null;

  @ApiPropertyOptional()
  ogTitle?: string | null;

  @ApiPropertyOptional()
  ogDescription?: string | null;

  @ApiPropertyOptional()
  ogImageUrl?: string | null;

  @ApiPropertyOptional()
  ogImageAlt?: string | null;

  @ApiPropertyOptional()
  canonicalUrl?: string | null;

  @ApiPropertyOptional({ example: 'index, follow' })
  robots?: string | null;

  @ApiPropertyOptional({ default: true })
  indexable?: boolean;

  @ApiPropertyOptional({
    type: Array,
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq?: unknown;

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
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  key: string;

  @ApiPropertyOptional({ default: true })
  indexable?: boolean;

  @ApiPropertyOptional({ default: true })
  isVisible?: boolean;

  @ApiPropertyOptional({ default: 0 })
  sortOrder?: number;

  @ApiProperty({ type: [TagTranslationResponse] })
  translations: TagTranslationResponse[];

  @ApiPropertyOptional()
  booksCount?: number;

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
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  totalPages: number;
}

export class PaginatedTagsResponse {
  @ApiProperty({ type: [TagResponse] })
  data: TagResponse[];

  @ApiProperty()
  meta: PaginationMeta;
}
