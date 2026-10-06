import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  SLUG_REGEX,
  SLUG_REGEX_README,
} from '../../../shared/validators/slug';

export class UpdateBookDto {
  @ApiPropertyOptional({
    description: `Unique book slug. ${SLUG_REGEX_README}`,
    example: 'harry-potter-updated',
    pattern: SLUG_PATTERN,
    maxLength: SLUG_MAX_LENGTH,
  })
  // `LEGACY-437`: `null` в `Book.slug` NOT NULL — 500; пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(SLUG_REGEX, { message: `Slug must match the pattern: ${SLUG_PATTERN}` })
  @MaxLength(SLUG_MAX_LENGTH, {
    message: `Slug must be at most ${SLUG_MAX_LENGTH} characters long`,
  })
  slug?: string;

  // More fields can be added as needed
}
