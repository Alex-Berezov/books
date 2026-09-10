import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Describes `BookService.getReaderBootstrap`, served by
 * `GET /:lang/books/:slug/reader-bootstrap`.
 */

/** One chapter of the resolved text version (`select: { id, number, title, content }`). */
export class ReaderBootstrapChapterDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Chapter number, ascending' })
  number!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: 'Full chapter text' })
  content!: string;
}

/**
 * Where the bearer of the token stopped reading.
 *
 * ⚠️ Present only for the token holder; anonymous callers get `null`
 * (`LEGACY-088` — this used to be addressable by `?userId=`).
 */
export class ReaderBootstrapProgressDto {
  @ApiPropertyOptional({ type: Number, nullable: true })
  chapterNumber!: number | null;

  @ApiProperty({ description: 'Offset inside the chapter' })
  position!: number;
}

/** Response of `GET /:lang/books/:slug/reader-bootstrap`. */
export class ReaderBootstrapResponseDto {
  @ApiProperty({ description: 'Canonical `Book.id`' })
  bookId!: string;

  @ApiProperty({ description: 'Id of the resolved text version' })
  versionId!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  author!: string;

  @ApiProperty({ type: ReaderBootstrapChapterDto, isArray: true })
  chapters!: ReaderBootstrapChapterDto[];

  @ApiPropertyOptional({
    type: ReaderBootstrapProgressDto,
    nullable: true,
    description: 'Null for anonymous callers and for a reader with no saved progress',
  })
  lastProgress!: ReaderBootstrapProgressDto | null;
}
