import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, IsOptional, IsUUID, Matches, MaxLength } from 'class-validator';
import { Language } from '@prisma/client';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CheckBookSlugQueryDto {
  @ApiProperty({
    description: 'Slug to check for uniqueness',
    example: 'harry-potter',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), {
    message: SLUG_REGEX_README,
  })
  @MaxLength(100, { message: 'Slug must be at most 100 characters long' })
  slug!: string;

  @ApiPropertyOptional({
    description:
      'Book ID to exclude from the check (when editing); with lang - the own book of the version, whose slugs are not a conflict',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'excludeId must be a valid UUID' })
  excludeId?: string;

  /**
   * When set, the slug of a language version is taken by another version of this language, or by
   * another book: its `Book.slug`, its version in any language or its old address in any language
   * (`BookService.checkVersionSlugExists`; the order of the checks only picks which holder is
   * named, the verdict is the same). When absent, `Book.slug` is checked by the rule of
   * its write (`findBookSlugConflict`, `LEGACY-437`): `Book.slug`, a version or an old address of
   * another book. Book creation relies on it (`books-front` `useCreateBookModal.ts`).
   */
  @ApiPropertyOptional({
    description:
      'Version language: check the slug of a language version; without it, the slug of the book (Book.slug). Both are taken when another book holds them: its Book.slug, a version or an old address',
    example: 'en',
    enum: Object.values(Language),
  })
  @IsOptional()
  @IsEnum(Language, { message: `Language must be one of: ${Object.values(Language).join(', ')}` })
  lang?: Language;

  @ApiPropertyOptional({
    description: 'Book version ID to exclude from the check (when editing); requires lang',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'excludeVersionId must be a valid UUID' })
  excludeVersionId?: string;
}
