import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';

/**
 * Response DTO — Swagger only (`STYLE_GUIDE.md` §7).
 *
 * `GET /admin/authors/:id/prompt-inputs` (F02-2): what the «Prompt inputs» button in the author
 * form copies into the data prompt — the author, its published books on the site per language and
 * every author of the site with a slug per language, so the model only uses existing slugs.
 */

export class AuthorPromptNameDto {
  @ApiProperty({ enum: Language })
  lang!: Language;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;
}

export class AuthorPromptBookDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: Number, nullable: true })
  firstPublishedYear!: number | null;

  @ApiProperty({ type: Boolean })
  hasAudio!: boolean;
}

export class AuthorPromptBooksDto {
  @ApiProperty({ enum: Language })
  lang!: Language;

  @ApiProperty({
    type: AuthorPromptBookDto,
    isArray: true,
    description: 'Same set and order as the author page',
  })
  items!: AuthorPromptBookDto[];

  @ApiProperty({
    type: Number,
    description: 'Published books in this language; > items.length when cut',
  })
  total!: number;
}

export class AuthorPromptSiteAuthorDto {
  @ApiProperty({ type: AuthorPromptNameDto, isArray: true })
  names!: AuthorPromptNameDto[];
}

export class AuthorPromptInputsResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  birthDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  deathDate!: string | null;

  @ApiProperty({
    type: AuthorPromptNameDto,
    isArray: true,
    description: 'This author per language',
  })
  names!: AuthorPromptNameDto[];

  @ApiProperty({ type: AuthorPromptBooksDto, isArray: true })
  books!: AuthorPromptBooksDto[];

  @ApiProperty({ type: AuthorPromptSiteAuthorDto, isArray: true })
  authors!: AuthorPromptSiteAuthorDto[];

  @ApiProperty({
    type: Boolean,
    description: 'The author list hit the row cap and is incomplete',
  })
  authorsTruncated!: boolean;
}
