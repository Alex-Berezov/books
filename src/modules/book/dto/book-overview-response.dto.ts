import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { PublicBookVersionDto } from './book-detail-response.dto';
import {
  BookCategoryWithTranslationsDto,
  BookTagWithTranslationsDto,
  BookVersionContentCountDto,
} from './book-taxonomy-response.dto';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Describes `BookService.getOverview`, served by `GET /books/:slug/overview` and its
 * language-prefixed twin `GET /:lang/books/:slug/overview`. Both call the same method
 * with the same arguments, so one DTO covers both.
 */

/**
 * A published version on the book page: the `PUBLIC_BOOK_VERSION_OVERVIEW_SELECT`
 * whitelist (`src/common/selects/public-book.select.ts`) — the card whitelist plus the
 * editorial fields the page renders — with the content counters and the `coverUrl`
 * compatibility alias the handler adds.
 *
 * ⚠️ The whitelist is what keeps the 29 `rights*` columns out of this response
 * (`LEGACY-090`); a field added here that is not in that constant would document
 * something the handler cannot return.
 */
export class BookOverviewVersionDto extends PublicBookVersionDto {
  @ApiPropertyOptional({ type: Number, nullable: true })
  firstPublishedYear!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  editionPublishedYear!: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  originalLanguage!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  originalTitle!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  copyrightStatus!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  authorPageUrl!: string | null;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description:
      'Json column. Shape held by `@IsArray()` on `CreateBookVersionDto.alternativeTitles`.',
    example: ['Dorian Gray'],
  })
  alternativeTitles!: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' } },
    },
    nullable: true,
    description: 'Json column. Shape held by `@IsArray()` on `CreateBookVersionDto.characters`.',
    example: [{ name: 'Dorian Gray', description: 'Main character' }],
  })
  characters!: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { text: { type: 'string' }, author: { type: 'string' } },
    },
    nullable: true,
    description: 'Json column. Shape held by `@IsArray()` on `CreateBookVersionDto.quotes`.',
    example: [{ text: 'To live is the rarest thing in the world.', author: 'Oscar Wilde' }],
  })
  quotes!: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { question: { type: 'string' }, answer: { type: 'string' } },
    },
    nullable: true,
    description: 'Json column. Shape held by `@IsArray()` on `CreateBookVersionDto.faq`.',
    example: [{ question: 'What is the genre?', answer: 'Gothic fiction' }],
  })
  faq!: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description:
      'Json column. Shape held by `@IsArray() @IsString({ each: true })` on `CreateBookVersionDto.themes`.',
    example: ['Art', 'Morality'],
  })
  themes!: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
    },
    nullable: true,
    description: 'Json column. Shape held by `@IsArray()` on `CreateBookVersionDto.symbols`.',
    example: [{ title: 'Portrait', description: 'Represents the soul' }],
  })
  symbols!: unknown;

  @ApiProperty({ type: BookVersionContentCountDto })
  _count!: BookVersionContentCountDto;

  @ApiProperty({ description: 'Compatibility alias of `coverImageUrl`' })
  coverUrl!: string;
}

/** `Category` with its translations plus the live per-language book count. */
export class BookOverviewCategoryDto extends BookCategoryWithTranslationsDto {
  @ApiProperty({
    description:
      'Published books carrying this category in the rendered language. Floor of `isTaxonomyLinkable` on the client.',
  })
  booksCount!: number;
}

/** `Tag` with its translations plus the live per-language book count. */
export class BookOverviewTagDto extends BookTagWithTranslationsDto {
  @ApiProperty({
    description:
      'Published books carrying this tag in the rendered language. Floor of `isTaxonomyLinkable` on the client.',
  })
  booksCount!: number;
}

/** One SEO bundle entry — `Seo.metaTitle`/`metaDescription` of the resolved version. */
export class BookOverviewSeoEntryDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  metaTitle!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaDescription!: string | null;
}

/**
 * The four SEO slots of the book page. Each is a **separate object** even when two
 * slots resolve to the same `Seo` row (`LEGACY-126`).
 */
export class BookOverviewSeoDto {
  @ApiPropertyOptional({ type: BookOverviewSeoEntryDto, nullable: true })
  main!: BookOverviewSeoEntryDto | null;

  @ApiPropertyOptional({ type: BookOverviewSeoEntryDto, nullable: true })
  read!: BookOverviewSeoEntryDto | null;

  @ApiPropertyOptional({ type: BookOverviewSeoEntryDto, nullable: true })
  listen!: BookOverviewSeoEntryDto | null;

  @ApiPropertyOptional({ type: BookOverviewSeoEntryDto, nullable: true })
  summary!: BookOverviewSeoEntryDto | null;
}

/** Resolved version ids per reading mode. */
export class BookOverviewVersionIdsDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  text!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  audio!: string | null;
}

/** Legacy `book` envelope kept for backwards compatibility with the frontend. */
export class BookOverviewBookRefDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;
}

/** Response of `GET /books/:slug/overview` and `GET /:lang/books/:slug/overview`. */
export class BookOverviewResponseDto {
  @ApiProperty({ description: 'Canonical `Book.id`' })
  id!: string;

  @ApiProperty({ description: 'Slug of the resolved version, or the requested one' })
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  author!: string;

  @ApiProperty({ description: 'Description with the boilerplate intro stripped' })
  description!: string;

  @ApiProperty({ description: '`coverImageUrl` of the resolved version, empty string when none' })
  coverUrl!: string;

  @ApiPropertyOptional({ type: Number, description: 'Average rating (0-5)', nullable: true })
  rating!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  firstPublishedYear!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  editionPublishedYear!: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'First published year, else edition year, else the year of `publishedAt`',
  })
  publicationYear!: number | null;

  @ApiPropertyOptional({
    enum: Language,
    description: 'Language actually rendered. Undefined when no version matched a request.',
  })
  language!: Language | undefined;

  @ApiProperty({ type: BookOverviewCategoryDto, isArray: true })
  categories!: BookOverviewCategoryDto[];

  @ApiProperty({ type: BookOverviewTagDto, isArray: true })
  tags!: BookOverviewTagDto[];

  @ApiPropertyOptional({ type: String, nullable: true })
  primaryCategoryId!: string | null;

  @ApiPropertyOptional({ type: BookCategoryWithTranslationsDto, nullable: true })
  primaryCategory!: BookCategoryWithTranslationsDto | null;

  @ApiProperty({ type: BookOverviewVersionDto, isArray: true })
  versions!: BookOverviewVersionDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: BookOverviewBookRefDto })
  book!: BookOverviewBookRefDto;

  @ApiProperty({ enum: Language, isArray: true })
  availableLanguages!: Language[];

  @ApiProperty()
  hasText!: boolean;

  @ApiProperty()
  hasAudio!: boolean;

  @ApiProperty()
  hasSummary!: boolean;

  @ApiProperty({ type: BookOverviewVersionIdsDto })
  versionIds!: BookOverviewVersionIdsDto;

  @ApiProperty({ type: BookOverviewSeoDto })
  seo!: BookOverviewSeoDto;
}
