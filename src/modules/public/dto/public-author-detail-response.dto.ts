import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { AuthorFaqDto, AuthorQuoteDto } from '../../author/dto/author-translation.dto';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';
import { BookCardDto } from '../../book/dto/book-card.dto';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Describes `AuthorService.getPublicBySlug`, served by `GET /:lang/authors/:slug`.
 * The handler assembles the object field by field from the matched
 * `AuthorTranslation` and its author, so nothing here mirrors a Prisma model wholesale.
 */

/**
 * A neighbouring author from `similarSlugs`. The slug is looked up in any language and
 * resolved to the same author's translation in the requested language (F02, T3).
 */
export class PublicSimilarAuthorDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Slug in the requested language; `null` when the author has no translation in it ' +
      '(show the name as plain text, without a link)',
  })
  slug!: string | null;
}

/** One translation of the author, for `hreflang`. */
export class PublicAuthorAlternateDto {
  @ApiProperty({ enum: Language })
  lang!: Language;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'Published books in this language > 0 — the same rule the author sitemap uses; ' +
      'only indexable languages go into `hreflang`',
  })
  indexable!: boolean;
}

/**
 * One published book of this author in the requested language: the shared book card
 * (`BookCardDto`, the same shape `/:lang/authors/:slug/books/cards` serves) plus the year.
 */
export class PublicAuthorBookDto extends BookCardDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`BookVersion.firstPublishedYear`; books are ordered by it, undated last',
  })
  firstPublishedYear!: number | null;
}

/** Response of `GET /:lang/authors/:slug`. */
export class PublicAuthorDetailResponseDto {
  @ApiProperty({ type: String, description: 'Canonical `Author.id`' })
  id!: string;

  @ApiProperty({ type: String, description: 'Slug of the matched translation' })
  slug!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'YYYY-MM-DD' })
  birthDate!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'YYYY-MM-DD' })
  deathDate!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  wikidataUrl!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  wikipediaUrl!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ type: String })
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  biography!: string | null;

  @ApiProperty({ type: AuthorQuoteDto, isArray: true, description: 'Empty array when unset' })
  quotes!: AuthorQuoteDto[];

  @ApiProperty({ type: AuthorFaqDto, isArray: true, description: 'Empty array when unset' })
  faq!: AuthorFaqDto[];

  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;

  @ApiProperty({ type: PublicAuthorAlternateDto, isArray: true })
  alternates!: PublicAuthorAlternateDto[];

  @ApiProperty({ type: PublicSimilarAuthorDto, isArray: true })
  similarAuthors!: PublicSimilarAuthorDto[];

  @ApiProperty({
    type: Number,
    description: 'Published books of the author in this language; counted separately from `books`',
  })
  booksTotal!: number;

  @ApiProperty({
    type: PublicAuthorBookDto,
    isArray: true,
    description: 'Ordered by `firstPublishedYear` asc (undated last), then title',
  })
  books!: PublicAuthorBookDto[];
}
