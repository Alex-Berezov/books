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
  h1?: string;

  @ApiPropertyOptional()
  shortDescription?: string | null;

  @ApiPropertyOptional()
  metaTitle?: string;

  @ApiPropertyOptional()
  metaDescription?: string | null;

  @ApiPropertyOptional()
  ogTitle?: string;

  @ApiPropertyOptional()
  ogDescription?: string | null;

  @ApiPropertyOptional()
  ogImageUrl?: string | null;

  @ApiPropertyOptional()
  ogImageAlt?: string;

  @ApiPropertyOptional()
  canonicalUrl?: string;

  @ApiPropertyOptional({ example: 'index, follow' })
  robots?: string;

  @ApiPropertyOptional({ default: true })
  indexable?: boolean;

  @ApiPropertyOptional({
    type: Array,
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq?: Array<{ question: string; answer: string }>;

  @ApiPropertyOptional({ type: [String], example: ['aestheticism', 'beauty'] })
  relatedTagSlugs?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['classic-literature', 'philosophical-fiction'],
  })
  relatedGenreSlugs?: string[];
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
