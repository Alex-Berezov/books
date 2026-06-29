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
}

export class TagResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ type: [TagTranslationResponse] })
  translations: TagTranslationResponse[];

  @ApiPropertyOptional()
  booksCount?: number;
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
