import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { BookCardDto } from './book-card.dto';
import { TagTranslationDto } from '../../tags/dto/tag-translation-entity.dto';
import { BookCardsPaginationDto } from './paged-book-cards.dto';

/** One resolved related-taxonomy term (`RelatedTaxonomyService.resolve` / `RelatedTerm`). */
export class RelatedTermDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  isVisible!: boolean;

  @ApiProperty()
  indexable!: boolean;

  @ApiProperty()
  autoIndexable!: boolean;

  @ApiProperty()
  langBookCount!: number;
}

/** `RelatedTerms` — four buckets of `RelatedTermDto`. */
export class RelatedTermsDto {
  @ApiProperty({ type: [RelatedTermDto] })
  tags!: RelatedTermDto[];

  @ApiProperty({ type: [RelatedTermDto] })
  genres!: RelatedTermDto[];

  @ApiProperty({ type: [RelatedTermDto] })
  categories!: RelatedTermDto[];

  @ApiProperty({ type: [RelatedTermDto] })
  collections!: RelatedTermDto[];
}

/**
 * `tag` field of `BookService.findCardsByTag`, present only when `includeTag=true`
 * and the tag resolves. Built by hand from the resolved `Tag` row, its matched
 * translation and resolved related terms — not a Prisma select.
 */
export class TagCardSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

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

  @ApiPropertyOptional({ type: TagTranslationDto, nullable: true })
  translation!: TagTranslationDto | null;

  @ApiProperty({ type: [TagTranslationDto] })
  translations!: TagTranslationDto[];

  @ApiProperty({ type: RelatedTermsDto })
  relatedTerms!: RelatedTermsDto;
}

/** Response of `BookService.findCardsByTag` — `GET /:lang/tags/:slug/books/cards`. */
export class TagBookCardsResponseDto {
  @ApiPropertyOptional({ type: TagCardSummaryDto, nullable: true })
  tag!: TagCardSummaryDto | null;

  @ApiProperty({ type: [BookCardDto] })
  items!: BookCardDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  pagination!: BookCardsPaginationDto;
}
