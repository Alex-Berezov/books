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
   * When set, the slug of a language version is checked the way a public address resolves:
   * versions of this language, then versions of other books in any language, then `Book.slug`
   * of other books (`BookService.checkVersionSlugExists`). When absent, the old `Book.slug`
   * check applies: book creation relies on it (`books-front` `useCreateBookModal.ts`).
   */
  @ApiPropertyOptional({
    description:
      'Version language: check BookVersion slug within this language instead of Book.slug',
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
