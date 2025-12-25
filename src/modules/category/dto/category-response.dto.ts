import { ApiProperty } from '@nestjs/swagger';
import { CategoryType, Language } from '@prisma/client';

export class CategoryTranslationResponse {
  @ApiProperty({ enum: Language })
  language: Language;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;
}

export class CategoryResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ enum: CategoryType })
  type: CategoryType;

  @ApiProperty()
  booksCount: number;

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
