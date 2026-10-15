import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { AuthorFaqDto } from '../../author/dto/author-translation.dto';
import {
  PublicAuthorAdaptationDto,
  PublicAuthorAwardDto,
  PublicAuthorFactsDto,
  PublicAuthorFunFactDto,
  PublicAuthorInfluencesDto,
  PublicAuthorNotableWorkDto,
  PublicAuthorPhotoCreditDto,
  PublicAuthorQuoteDto,
  PublicAuthorSourceDto,
  PublicAuthorStartHereDto,
  PublicAuthorTimelineEventDto,
} from './public-author-page-blocks.dto';
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
      'Slug in the requested language; `null` in two cases — the author has no translation ' +
      'in it, or has one but no published books in it (the page is `noindex` and not in the ' +
      'sitemap). Either way show the name as plain text, without a link',
  })
  slug!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Portrait URL (F02-2)' })
  photoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'YYYY-MM-DD or YYYY' })
  birthDate!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'YYYY-MM-DD or YYYY' })
  deathDate!: string | null;
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

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Full name in the native language and script (F02-2)',
  })
  nativeName!: string | null;

  @ApiProperty({ type: PublicAuthorPhotoCreditDto, nullable: true, description: 'F02-2' })
  photoCredit!: PublicAuthorPhotoCreditDto | null;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Who this is, one line (F02-2)' })
  tagline!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  biography!: string | null;

  @ApiProperty({ type: PublicAuthorFactsDto, nullable: true, description: 'F02-2' })
  facts!: PublicAuthorFactsDto | null;

  @ApiProperty({
    type: PublicAuthorNotableWorkDto,
    isArray: true,
    description: 'By year asc, undated last; empty array when unset (F02-2)',
  })
  notableWorks!: PublicAuthorNotableWorkDto[];

  @ApiProperty({
    type: PublicAuthorStartHereDto,
    isArray: true,
    description: 'Reading order as entered; books not on the site are dropped (F02-2)',
  })
  startHere!: PublicAuthorStartHereDto[];

  @ApiProperty({
    type: PublicAuthorTimelineEventDto,
    isArray: true,
    description: 'By year asc (F02-2)',
  })
  timeline!: PublicAuthorTimelineEventDto[];

  @ApiProperty({ type: PublicAuthorInfluencesDto, nullable: true, description: 'F02-2' })
  influences!: PublicAuthorInfluencesDto | null;

  @ApiProperty({
    type: PublicAuthorAwardDto,
    isArray: true,
    description: 'By year asc, undated last (F02-2)',
  })
  awards!: PublicAuthorAwardDto[];

  @ApiProperty({
    type: PublicAuthorAdaptationDto,
    isArray: true,
    description: 'By year asc, undated last (F02-2)',
  })
  adaptations!: PublicAuthorAdaptationDto[];

  @ApiProperty({ type: PublicAuthorFunFactDto, isArray: true, description: 'F02-2' })
  funFacts!: PublicAuthorFunFactDto[];

  @ApiProperty({ type: PublicAuthorSourceDto, isArray: true, description: 'F02-2' })
  sources!: PublicAuthorSourceDto[];

  @ApiProperty({
    type: PublicAuthorQuoteDto,
    isArray: true,
    description: 'Empty array when unset; `book` resolved from `bookSlug` (F02-2)',
  })
  quotes!: PublicAuthorQuoteDto[];

  @ApiProperty({ type: AuthorFaqDto, isArray: true, description: 'Empty array when unset' })
  faq!: AuthorFaqDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Last change of this translation content (F02-2)',
  })
  updatedAt!: Date;

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
    type: Boolean,
    description:
      'Any published book of the author in this language has audio (all books, not only `books`)',
  })
  booksHasAudio!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean of per-book average ratings over published books in this language (first 500 rated books by id); null when none is rated',
  })
  booksAvgRating!: number | null;

  @ApiProperty({
    type: PublicAuthorBookDto,
    isArray: true,
    description:
      'First 12 books ordered by `firstPublishedYear` asc (undated last), then title; the rest — `/books/cards` of the author',
  })
  books!: PublicAuthorBookDto[];
}
