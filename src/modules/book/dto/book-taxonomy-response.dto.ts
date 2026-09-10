import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { BookCategoryDto, BookTagDto } from './book-detail-response.dto';
import { TagTranslationDto } from '../../tags/dto/tag-translation-entity.dto';

/**
 * Building blocks shared by the routes that attach taxonomy **with its translations**
 * to a book: `GET /books/:slug/overview`, `GET /books`, `GET /:lang/books` and
 * `GET /:lang/categories/:slug/books`.
 *
 * They are deliberately separate from `book-detail-response.dto.ts`'s `BookCategoryDto` /
 * `BookTagDto`: those describe the bare `Category`/`Tag` row that `findOne`/`findBySlug`
 * return, while everything here is that same row loaded with
 * `include: { translations: true }`.
 *
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 */

/**
 * Scalar columns of `CategoryTranslation` (`prisma/schema.prisma`) as they arrive from
 * `include: { translations: true }` — no `seo`, no `category` back-relation.
 *
 * Not `CategoryTranslationEntityDto` (`category/dto/category-translation-entity.dto.ts`):
 * that one documents an optional `seo`, which these routes never load, and a schema that
 * promises a field the handler cannot produce is as misleading as one that omits a field
 * it does.
 *
 * Тот же набор колонок приходит из `BookService.findCardsByCategory`
 * (`GET /:lang/categories/:slug/books/cards`), где перевод читается вовсе без
 * `select`/`include`, — поэтому он берёт этот класс, а не заводит свою копию.
 */
export class CategoryTranslationScalarsDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  categoryId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  h1!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaTitle!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaDescription!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogTitle!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogDescription!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogImageUrl!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogImageAlt!: string | null;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { question: { type: 'string' }, answer: { type: 'string' } },
    },
    nullable: true,
    description:
      'Json column. Shape held by `@IsArray() @IsObject({ each: true })` on `CreateCategoryTranslationDto.faq`.',
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq!: unknown;

  @ApiProperty({ default: 0 })
  bookCount!: number;

  @ApiProperty({ default: true })
  autoIndexable!: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true })
  seoId!: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/** `Category` row with its translations (`include: { translations: true }`). */
export class BookCategoryWithTranslationsDto extends BookCategoryDto {
  @ApiProperty({ type: CategoryTranslationScalarsDto, isArray: true })
  translations!: CategoryTranslationScalarsDto[];
}

/** `Tag` row with its translations (`include: { translations: true }`). */
export class BookTagWithTranslationsDto extends BookTagDto {
  @ApiProperty({ type: TagTranslationDto, isArray: true })
  translations!: TagTranslationDto[];
}

/**
 * One `BookTag` join row as selected by the book lists:
 * `tags: { select: { tag: { include: { translations: true } } } }`.
 *
 * ⚠️ The join wrapper is part of the response: unlike `findOne`/`findBySlug`, these
 * handlers do **not** map `t.tag` up a level, so the client sees `tags[].tag`.
 */
export class BookVersionTagLinkDto {
  @ApiProperty({ type: BookTagWithTranslationsDto })
  tag!: BookTagWithTranslationsDto;
}

/** `_count` of a book version: published content present per kind. */
export class BookVersionContentCountDto {
  @ApiProperty()
  chapters!: number;

  @ApiProperty()
  audioChapters!: number;

  @ApiProperty()
  summaries!: number;
}
