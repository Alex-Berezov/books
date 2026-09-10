import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryType } from '@prisma/client';
import { CategoryTranslationResponse } from './category-response.dto';

export class CategoryTreeNodeDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiProperty({ type: 'string', nullable: true, required: false })
  parentId?: string | null;

  @ApiProperty({ type: Number, description: 'Number of books in this category' })
  booksCount!: number;

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
   * Обязательные: `CategoryService.getTree` собирает узел вручную и кладёт все
   * три безусловно — `indexable: c.indexable ?? true`, `isVisible: ... ?? true`,
   * `sortOrder: ... ?? 0` (`category.service.ts:1018-1020`). Тип узла
   * (`CategoryTreeNode`, `category.service.ts:35-37`) объявляет их так же.
   */
  @ApiProperty({ type: Boolean, default: true })
  indexable!: boolean;

  @ApiProperty({ type: Boolean, default: true })
  isVisible!: boolean;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;

  @ApiProperty({ type: [CategoryTranslationResponse] })
  translations?: CategoryTranslationResponse[];

  @ApiProperty({ type: () => [CategoryTreeNodeDto] })
  children!: CategoryTreeNodeDto[];
}
