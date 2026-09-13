import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicBookVersionDto } from './book-detail-response.dto';
import { BookVersionContentCountDto, BookVersionTagLinkDto } from './book-taxonomy-response.dto';
import { BookCardsPaginationDto } from './paged-book-cards.dto';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Describes `BookService.findAll`, which serves two routes with the same shape and
 * different contents: the admin `GET /books` (all statuses) and the public
 * `GET /:lang/books` (`publishedOnly`, `LEGACY-093`). The filter changes which rows
 * and which nested versions come back, never the fields — so one DTO covers both.
 */

/**
 * A book version inside `BookService.findAll`: the `PUBLIC_BOOK_VERSION_SELECT`
 * whitelist (`src/common/selects/public-book.select.ts`) plus the per-kind content
 * counters and the tag join rows the same `select` asks for.
 */
export class BookListVersionDto extends PublicBookVersionDto {
  @ApiProperty({ type: BookVersionContentCountDto })
  _count!: BookVersionContentCountDto;

  @ApiProperty({ type: BookVersionTagLinkDto, isArray: true })
  tags!: BookVersionTagLinkDto[];
}

/**
 * One row of `BookService.findAll`: the `PUBLIC_BOOK_SELECT` book columns plus the
 * average rating and the three availability flags computed from the versions.
 */
export class BookListItemDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: BookListVersionDto, isArray: true })
  versions!: BookListVersionDto[];

  @ApiPropertyOptional({ type: Number, description: 'Average rating (0-5)', nullable: true })
  rating!: number | null;

  @ApiProperty({
    type: Boolean,
    description: 'A published version with chapters or of type `text` exists',
  })
  hasText!: boolean;

  @ApiProperty({ type: Boolean, description: 'A published version with audio chapters exists' })
  hasAudio!: boolean;

  @ApiProperty({ type: Boolean, description: 'A published version with a summary exists' })
  hasSummary!: boolean;
}

/**
 * Response of the **public** `GET /:lang/books` (`BookService.findAll`).
 *
 * ⚠️ Админское зеркало `GET /books` этим DTO больше не описывается: с `LEGACY-177`
 * оно отдаёт единую форму `{items, pagination}` (`BookController.findAll` оборачивает
 * результат сервиса). Публичный ответ остался `{data, meta}` намеренно — он лежит
 * в edge-кэше Cloudflare, и смена его формы требует сброса кэша на боевом домене
 * (решение арбитра 13.09.2026). Класс поэтому не удалён, а сужен до одного маршрута.
 */
export class PaginatedBooksResponseDto {
  @ApiProperty({ type: BookListItemDto, isArray: true })
  data!: BookListItemDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  meta!: BookCardsPaginationDto;
}
