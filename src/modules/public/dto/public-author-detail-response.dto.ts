import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookType, Language, PublicationStatus } from '@prisma/client';
import { AuthorFaqDto, AuthorQuoteDto } from '../../author/dto/author-translation.dto';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Describes `AuthorService.getPublicBySlug`, served by `GET /:lang/authors/:slug`.
 * The handler assembles the object field by field from the matched
 * `AuthorTranslation` and its author, so nothing here mirrors a Prisma model wholesale.
 */

/** A neighbouring author linked from `similarSlugs`, resolved in the requested language. */
export class PublicSimilarAuthorDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;
}

/**
 * The single-element `versions` array each book of the author page carries.
 *
 * ⚠️ It always holds exactly one entry — the version the row was built from — and
 * exists so the frontend book card can read the same path it reads elsewhere.
 */
export class PublicAuthorBookVersionDto {
  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ enum: PublicationStatus })
  status!: PublicationStatus;

  @ApiProperty({ enum: BookType })
  type!: BookType;

  @ApiProperty({ type: String })
  coverImageUrl!: string;

  @ApiProperty({ type: String, description: 'Compatibility alias of `coverImageUrl`' })
  coverUrl!: string;
}

/** One published book of this author in the requested language. */
export class PublicAuthorBookDto {
  @ApiProperty({ type: String, description: '`BookVersion.id` of the matched version' })
  id!: string;

  @ApiProperty({ type: String, description: 'Canonical `Book.id`' })
  bookId!: string;

  @ApiProperty({ type: String, description: '`BookVersion.slug`, falling back to `Book.slug`' })
  slug!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  author!: string;

  @ApiProperty({ type: String })
  coverImageUrl!: string;

  @ApiProperty({ type: String, description: 'Compatibility alias of `coverImageUrl`' })
  coverUrl!: string;

  @ApiProperty({ enum: BookType })
  type!: BookType;

  @ApiProperty({ type: Boolean })
  isFree!: boolean;

  @ApiPropertyOptional({ type: Number, description: 'Average rating (0-5)', nullable: true })
  rating!: number | null;

  @ApiProperty({ type: PublicAuthorBookVersionDto, isArray: true })
  versions!: PublicAuthorBookVersionDto[];
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

  @ApiProperty({ type: PublicSimilarAuthorDto, isArray: true })
  similarAuthors!: PublicSimilarAuthorDto[];

  @ApiProperty({ type: PublicAuthorBookDto, isArray: true })
  books!: PublicAuthorBookDto[];
}
