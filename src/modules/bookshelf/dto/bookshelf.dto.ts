import { ApiProperty } from '@nestjs/swagger';
import type {
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  PaginationWithNextDto,
  PaginatedResult,
  paginatedSchema,
} from '../../../shared/dto/paginated-response.dto';

/** Книга-контейнер в строке полки: полке хватает адреса, всю запись сюда тянуть незачем. */
export class BookshelfBookDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'portret-doriana-greya' })
  slug!: string;
}

export class BookVersionDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookId!: string;

  @ApiProperty({ type: String, example: 'en' })
  language!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  author!: string;

  @ApiProperty({ type: String })
  description!: string;

  @ApiProperty({ type: String, example: 'https://example.com/c.jpg' })
  coverImageUrl!: string;

  @ApiProperty({ type: String, example: 'text' })
  type!: string;

  @ApiProperty({ type: Boolean })
  isFree!: boolean;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;

  /**
   * Слаг версии. В схеме поле `BookVersion.slug` объявлено `String?`
   * (`prisma/schema.prisma:64`), и до 13.09.2026 DTO обещало непустую строку —
   * расхождение всплыло, когда возврат сервиса стали сверять с этим DTO.
   */
  @ApiProperty({ type: String, nullable: true, example: 'portret-doriana-greya' })
  slug!: string | null;

  @ApiProperty({ type: Number, description: 'Число глав версии' })
  chaptersCount!: number;

  @ApiProperty({ type: BookshelfBookDto })
  book!: BookshelfBookDto;
}

export class BookshelfItemDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Date })
  addedAt!: Date;

  @ApiProperty({ type: () => BookVersionDto })
  bookVersion!: BookVersionDto;
}

// Ответ на добавление - это строка Prisma целиком (bookshelf.service.ts: create/findFirst
// без `select`), а не элемент списка: `bookVersion` в ней нет, зато есть `userId`
// и `bookVersionId`. До 09.09.2026 маршрут ссылался на BookshelfItemDto, и схема
// молчала о двух отданных полях, обещая взамен вложенную версию книги.
export class BookshelfEntryDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  userId!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: Date })
  addedAt!: Date;
}

/** Ответ `GET /me/bookshelf`: строки полки плюс пагинация с `hasNext`. */
export interface PagedBookshelf extends PaginatedResult<BookshelfItemDto> {
  pagination: PaginationWithNextDto;
}

/**
 * Схема ответа для `@ApiOkResponse`: общая `{items, pagination}` с пагинацией,
 * несущей `hasNext`. Форма обёртки остаётся у `paginatedSchema`.
 *
 * ⚠️ Признак считается `take: limit + 1` — честное «есть ещё строка» без второго
 * запроса. Замена его на сравнение с `total` вернула бы расхождение на гонке
 * «добавили в полку между `findMany` и `count`».
 */
export const pagedBookshelfSchema = (): SchemaObject & Partial<ReferenceObject> =>
  paginatedSchema(BookshelfItemDto, PaginationWithNextDto);
