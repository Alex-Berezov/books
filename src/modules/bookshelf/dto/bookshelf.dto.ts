import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({ type: String, example: 'portret-doriana-greya' })
  slug!: string;

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

export class BookshelfListDto {
  @ApiProperty({ type: () => [BookshelfItemDto] })
  items!: BookshelfItemDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 10 })
  limit!: number;

  @ApiProperty({ type: Number, example: 1 })
  total!: number;

  @ApiProperty({ type: Boolean, example: false })
  hasNext!: boolean;
}
