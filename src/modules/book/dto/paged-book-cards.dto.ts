import { ApiProperty } from '@nestjs/swagger';
import { BookCardDto } from './book-card.dto';

/**
 * Pagination summary `{page,limit,total,totalPages}`, all values applied (not
 * requested). Emitted by `BookService.findCards` / `findCardsByAuthor` /
 * `findCardsByCategory` / `findCardsByTag` (per `buildCardsResponse`) and reused
 * verbatim as the `meta` of the `{data,meta}` lists that carry the same four numbers
 * (`BookService.findAll`, `CategoryService.getByLangSlugWithBooks`,
 * `AuthorService.listPublic`).
 */
export class BookCardsPaginationDto {
  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

/** Response of `BookService.findCards` / `findCardsByAuthor`. */
export class PagedBookCardsDto {
  @ApiProperty({ type: [BookCardDto] })
  items!: BookCardDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  pagination!: BookCardsPaginationDto;
}

/** Response of `BookService.findRelated` — `GET /books/:slug/related` and its
 * language-prefixed twin. */
export class RelatedBooksResponseDto {
  @ApiProperty({ type: [BookCardDto] })
  sameAuthor!: BookCardDto[];

  @ApiProperty({ type: [BookCardDto] })
  similar!: BookCardDto[];
}
