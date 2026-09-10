import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookType, CategoryType, Language, PublicationStatus } from '@prisma/client';

/**
 * Category as attached to a book version in `GET /books/:id` and `GET /books/slug/:slug`
 * (`BookService.findOne` / `findBySlug`, `categories: { select: { category: true } }`).
 *
 * Raw `Category` scalars only — no translations, no computed `booksCount`. This is a
 * different shape from `category/dto/category-response.dto.ts`'s `CategoryResponse`,
 * which describes the admin/public category listing, not this nested form.
 */
export class BookCategoryDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: Boolean })
  indexable!: boolean;

  @ApiProperty({ type: Boolean })
  isVisible!: boolean;

  @ApiProperty({ type: Number })
  sortOrder!: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentId!: string | null;
}

/**
 * Tag as attached to a book version in `GET /books/:id` and `GET /books/slug/:slug`
 * (`categories: { select: { tag: true } }`). Raw `Tag` scalars only, same reasoning
 * as `BookCategoryDto`.
 */
export class BookTagDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: Boolean })
  indexable!: boolean;

  @ApiProperty({ type: Boolean })
  isVisible!: boolean;

  @ApiProperty({ type: Number })
  sortOrder!: number;
}

/**
 * `BookVersion` as whitelisted by `PUBLIC_BOOK_VERSION_SELECT`
 * (`src/common/selects/public-book.select.ts`). Reused wherever a controller returns
 * that exact select verbatim.
 */
export class PublicBookVersionDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ enum: PublicationStatus })
  status!: PublicationStatus;

  @ApiProperty({ enum: BookType })
  type!: BookType;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  author!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  authorId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  slug!: string | null;

  @ApiProperty({ type: String })
  coverImageUrl!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  coverAlt!: string | null;

  @ApiProperty({ type: String })
  description!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription!: string | null;

  @ApiProperty({ type: Boolean })
  isFree!: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  publishedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/**
 * `PublicBookVersionDto` plus the categories/tags attached by `BookService.findOne`
 * and `findBySlug` (both map `categories`/`tags` join rows down to the bare
 * `Category`/`Tag` records).
 */
export class BookDetailVersionDto extends PublicBookVersionDto {
  @ApiProperty({ type: [BookCategoryDto] })
  categories!: BookCategoryDto[];

  @ApiProperty({ type: [BookTagDto] })
  tags!: BookTagDto[];
}

/**
 * Response of `GET /books/:id` and `GET /books/slug/:slug` (`BookService.findOne` /
 * `findBySlug`). Book fields are `PUBLIC_BOOK_SELECT` (id/slug/createdAt/updatedAt),
 * plus the computed average `rating` and the version list (drafts included only for
 * moderators — same shape either way).
 */
export class BookDetailResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: Number, description: 'Average rating (0-5)', nullable: true })
  rating!: number | null;

  @ApiProperty({ type: [BookDetailVersionDto] })
  versions!: BookDetailVersionDto[];
}
