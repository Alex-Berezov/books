import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryType, Language } from '@prisma/client';

export class CategoryTranslationResponse {
  @ApiProperty({ enum: Language })
  language: Language;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiPropertyOptional()
  h1?: string | null;

  @ApiPropertyOptional()
  shortDescription?: string | null;

  @ApiPropertyOptional()
  description?: string | null;

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
  faq?: Record<string, unknown> | null;
}

export class CategoryResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  key: string;

  @ApiProperty({ enum: CategoryType })
  type: CategoryType;

  @ApiProperty()
  booksCount: number;

  @ApiPropertyOptional({ default: true })
  indexable?: boolean;

  @ApiPropertyOptional({ default: true })
  isVisible?: boolean;

  @ApiPropertyOptional({ default: 0 })
  sortOrder?: number;

  @ApiProperty({ type: [CategoryTranslationResponse] })
  translations: CategoryTranslationResponse[];
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

export class PaginatedCategoriesResponse {
  @ApiProperty({ type: [CategoryResponse] })
  data: CategoryResponse[];

  @ApiProperty()
  meta: PaginationMeta;
}
