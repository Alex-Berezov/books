import { ApiProperty } from '@nestjs/swagger';

export class BookVersionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bookId!: string;

  @ApiProperty({ example: 'en' })
  language!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  author!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ example: 'https://example.com/c.jpg' })
  coverImageUrl!: string;

  @ApiProperty({ example: 'text' })
  type!: string;

  @ApiProperty()
  isFree!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class BookshelfItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  addedAt!: Date;

  @ApiProperty({ type: () => BookVersionDto })
  bookVersion!: BookVersionDto;
}

export class BookshelfListDto {
  @ApiProperty({ type: () => [BookshelfItemDto] })
  items!: BookshelfItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 10 })
  limit!: number;

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: false })
  hasNext!: boolean;
}
