import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryType, Language } from '@prisma/client';
import { BookCardDto } from './book-card.dto';
import { CategoryTranslationScalarsDto } from './book-taxonomy-response.dto';
import { BookCardsPaginationDto } from './paged-book-cards.dto';

/**
 * `category` field of `BookService.findCardsByCategory` — built by hand from the
 * resolved `Category` row plus its matched translation, not a Prisma select.
 */
export class CategoryCardSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentId!: string | null;

  @ApiProperty()
  indexable!: boolean;

  @ApiProperty()
  isVisible!: boolean;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  booksCount!: number;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiPropertyOptional({ type: CategoryTranslationScalarsDto, nullable: true })
  translation!: CategoryTranslationScalarsDto | null;

  @ApiProperty({ type: [CategoryTranslationScalarsDto] })
  translations!: CategoryTranslationScalarsDto[];
}

/** Response of `BookService.findCardsByCategory` — `GET /:lang/categories/:slug/books/cards`. */
export class CategoryBookCardsResponseDto {
  @ApiPropertyOptional({ type: CategoryCardSummaryDto, nullable: true })
  category!: CategoryCardSummaryDto | null;

  @ApiProperty({ type: [BookCardDto] })
  items!: BookCardDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  pagination!: BookCardsPaginationDto;
}
