import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryType } from '@prisma/client';
import { CategoryTranslationResponse } from './category-response.dto';

export class CategoryTreeNodeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiProperty({ type: 'string', nullable: true, required: false })
  parentId?: string | null;

  @ApiProperty({ description: 'Number of books in this category' })
  booksCount!: number;

  @ApiPropertyOptional({ default: true })
  indexable?: boolean;

  @ApiPropertyOptional({ default: true })
  isVisible?: boolean;

  @ApiPropertyOptional({ default: 0 })
  sortOrder?: number;

  @ApiProperty({ type: [CategoryTranslationResponse] })
  translations?: CategoryTranslationResponse[];

  @ApiProperty({ type: () => [CategoryTreeNodeDto] })
  children!: CategoryTreeNodeDto[];
}
