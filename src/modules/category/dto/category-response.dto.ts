import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import { CategoryType, Language } from '@prisma/client';

export class CategoryTranslationResponse {
  @ApiProperty({ enum: Language })
  language: Language;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ type: String })
  slug: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  h1?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  description?: string | null;

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

  @ApiPropertyOptional({ type: [FaqItemDto], nullable: true })
  faq?: FaqItemDto[] | null;

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

export class CategoryResponse {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty({ type: String })
  name: string;

  @ApiProperty({ type: String })
  slug: string;

  @ApiProperty({ type: String })
  key: string;

  @ApiProperty({ enum: CategoryType })
  type: CategoryType;

  @ApiProperty({ type: Number })
  booksCount: number;

  @ApiPropertyOptional({
    description:
      'Cached per-language book count (CategoryTranslation.bookCount) for the requested ?lang. Undefined when lang is not passed or the term has no translation for it.',
  })
  langBookCount?: number;

  @ApiPropertyOptional({
    description:
      'Automatic indexability (hysteresis state) for the requested ?lang. Mirrors what meta robots and the sitemap decide. Undefined when lang is not passed or the term has no translation for it.',
  })
  autoIndexable?: boolean;

  /**
   * Обязательные, а не необязательные: `CategoryService.list` кладёт все три
   * в каждый элемент выдачи безусловно — `indexable: item.indexable ?? true`,
   * `isVisible: ... ?? true`, `sortOrder: ... ?? 0`
   * (`category.service.ts:171-173`). «Может отсутствовать» было бы неправдой
   * о форме ответа, а рукописные типы фронта сверяются с этой схемой машинно.
   */
  @ApiProperty({ type: Boolean, default: true })
  indexable!: boolean;

  @ApiProperty({ type: Boolean, default: true })
  isVisible!: boolean;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;

  @ApiProperty({ type: [CategoryTranslationResponse] })
  translations: CategoryTranslationResponse[];
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

export class PaginatedCategoriesResponse {
  @ApiProperty({ type: [CategoryResponse] })
  data: CategoryResponse[];

  @ApiProperty()
  meta: PaginationMeta;
}
