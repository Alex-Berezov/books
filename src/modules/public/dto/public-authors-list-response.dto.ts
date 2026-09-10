import { Language } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookCardsPaginationDto } from '../../book/dto/paged-book-cards.dto';

/** `PublicAuthorTranslation` — one language alternative of an author list item. */
export class PublicAuthorTranslationDto {
  /** Всегда одно из пяти значений `Language`: сервис кладёт сюда колонку Prisma. */
  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  name!: string;
}

/** `PublicAuthorListItem` — one row of `GET /:lang/authors` (`AuthorService.listPublic`). */
export class PublicAuthorListItemDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  birthDate!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  deathDate!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortBio!: string | null;

  @ApiProperty({ type: Number })
  booksCount!: number;

  @ApiProperty({ type: Number })
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
