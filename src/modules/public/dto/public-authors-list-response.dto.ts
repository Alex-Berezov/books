import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookCardsPaginationDto } from '../../book/dto/paged-book-cards.dto';

/** `PublicAuthorTranslation` — one language alternative of an author list item. */
export class PublicAuthorTranslationDto {
  @ApiProperty()
  language!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;
}

/** `PublicAuthorListItem` — one row of `GET /:lang/authors` (`AuthorService.listPublic`). */
export class PublicAuthorListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  birthDate!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  deathDate!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortBio!: string | null;

  @ApiProperty()
  booksCount!: number;

  @ApiProperty()
  audioCount!: number;

  @ApiProperty({ type: [PublicAuthorTranslationDto] })
  translations!: PublicAuthorTranslationDto[];
}

/** Response of `GET /:lang/authors` (`AuthorService.listPublic`). */
export class PublicAuthorsListResponseDto {
  @ApiProperty({ type: [PublicAuthorListItemDto] })
  data!: PublicAuthorListItemDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  meta!: BookCardsPaginationDto;
}
