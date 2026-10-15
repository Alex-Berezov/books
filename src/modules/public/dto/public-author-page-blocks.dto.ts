import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AUTHOR_ADAPTATION_KINDS,
  AUTHOR_GENDERS,
  AuthorAdaptationKind,
} from '../../author/dto/author-page-blocks.dto';

/**
 * Response DTO — Swagger only, no `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Blocks of the author page served by `GET /:lang/authors/:slug` (F02-2). The stored shape is
 * described by the write DTOs in `author/dto/author-page-blocks.dto.ts`; here every slug from the
 * data comes back resolved to a card or an author link in the requested language, or `null` when
 * the site has nothing to link to (show the title or name as plain text).
 */

/** A book of the site referenced from the author data, in the requested language. */
export class PublicAuthorPageBookDto {
  @ApiProperty({ type: String, description: 'Slug of the published version in this language' })
  slug!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  coverUrl!: string;
}

/** An author of the site referenced from `influences`, linkable in the requested language. */
export class PublicAuthorPageAuthorLinkDto {
  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  name!: string;
}

export class PublicAuthorPhotoCreditDto {
  @ApiProperty({ type: String })
  author!: string;

  @ApiProperty({ type: String })
  license!: string;

  @ApiPropertyOptional({ type: String })
  licenseUrl?: string;

  @ApiPropertyOptional({ type: String })
  sourceUrl?: string;
}

export class PublicAuthorFactsDto {
  @ApiPropertyOptional({ enum: AUTHOR_GENDERS })
  gender?: (typeof AUTHOR_GENDERS)[number];

  @ApiPropertyOptional({ type: String })
  birthPlace?: string;

  @ApiPropertyOptional({ type: String })
  deathPlace?: string;

  @ApiPropertyOptional({ type: String })
  nationality?: string;

  @ApiPropertyOptional({ type: [String] })
  occupations?: string[];

  @ApiPropertyOptional({ type: [String] })
  movements?: string[];

  @ApiPropertyOptional({ type: [String] })
  genres?: string[];

  @ApiPropertyOptional({ type: [String] })
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  pseudonyms?: string[];
}

export class PublicAuthorNotableWorkDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiPropertyOptional({ type: Number })
  year?: number;

  @ApiPropertyOptional({ type: String })
  bookSlug?: string;

  @ApiProperty({ type: PublicAuthorPageBookDto, nullable: true })
  book!: PublicAuthorPageBookDto | null;
}

export class PublicAuthorStartHereDto {
  @ApiProperty({ type: String })
  bookSlug!: string;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty({
    type: PublicAuthorPageBookDto,
    description: 'Always resolved: entries whose book is not on the site are dropped',
  })
  book!: PublicAuthorPageBookDto;
}

export class PublicAuthorTimelineEventDto {
  @ApiProperty({ type: Number })
  year!: number;

  @ApiProperty({ type: String })
  text!: string;

  @ApiPropertyOptional({ type: String })
  bookSlug?: string;

  @ApiProperty({ type: PublicAuthorPageBookDto, nullable: true })
  book!: PublicAuthorPageBookDto | null;
}

export class PublicAuthorInfluenceRefDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiPropertyOptional({ type: String })
  authorSlug?: string;

  @ApiProperty({
    type: PublicAuthorPageAuthorLinkDto,
    nullable: true,
    description:
      '`null` when the author is not on the site, has no translation in this language or ' +
      'no published books in it (the page would be `noindex`)',
  })
  author!: PublicAuthorPageAuthorLinkDto | null;
}

export class PublicAuthorInfluencesDto {
  @ApiProperty({ type: PublicAuthorInfluenceRefDto, isArray: true })
  influencedBy!: PublicAuthorInfluenceRefDto[];

  @ApiProperty({ type: PublicAuthorInfluenceRefDto, isArray: true })
  influenced!: PublicAuthorInfluenceRefDto[];
}

export class PublicAuthorAwardDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiPropertyOptional({ type: Number })
  year?: number;

  @ApiPropertyOptional({ type: Boolean })
  nomination?: boolean;
}

export class PublicAuthorAdaptationDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiPropertyOptional({ type: Number })
  year?: number;

  @ApiProperty({ enum: AUTHOR_ADAPTATION_KINDS })
  kind!: AuthorAdaptationKind;

  @ApiPropertyOptional({ type: String })
  basedOn?: string;

  @ApiPropertyOptional({ type: String })
  bookSlug?: string;

  @ApiProperty({ type: PublicAuthorPageBookDto, nullable: true })
  book!: PublicAuthorPageBookDto | null;
}

export class PublicAuthorFunFactDto {
  @ApiProperty({ type: String })
  text!: string;

  @ApiProperty({ type: String })
  sourceTitle!: string;

  @ApiProperty({ type: String })
  sourceUrl!: string;
}

export class PublicAuthorSourceDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  url!: string;
}

export class PublicAuthorQuoteDto {
  @ApiProperty({ type: String })
  text!: string;

  @ApiPropertyOptional({ type: String })
  source?: string;

  @ApiPropertyOptional({ type: String })
  bookSlug?: string;

  @ApiProperty({ type: PublicAuthorPageBookDto, nullable: true })
  book!: PublicAuthorPageBookDto | null;
}
