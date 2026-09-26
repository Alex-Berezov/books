import { ApiProperty } from '@nestjs/swagger';
import { PaginationInfoDto } from '../../../shared/dto/paginated-response.dto';
import { BookCardDto } from './book-card.dto';

/** Response of `BookService.findCards` / `findCardsByAuthor`. */
export class PagedBookCardsDto {
  @ApiProperty({ type: [BookCardDto] })
  items!: BookCardDto[];

  @ApiProperty({ type: PaginationInfoDto })
  pagination!: PaginationInfoDto;
}

/** Response of `BookService.findRelated` — `GET /books/:slug/related` and its
 * language-prefixed twin. */
export class RelatedBooksResponseDto {
  @ApiProperty({ type: [BookCardDto] })
  sameAuthor!: BookCardDto[];

  @ApiProperty({ type: [BookCardDto] })
  similar!: BookCardDto[];
}
