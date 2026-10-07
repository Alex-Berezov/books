import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  SLUG_REGEX,
  SLUG_REGEX_README,
} from '../../../shared/validators/slug';

export class UpdateBookDto {
  @ApiPropertyOptional({
    description: `Unique book slug. ${SLUG_REGEX_README}. The ${SLUG_MAX_LENGTH}-character limit applies only when the slug changes: the book's current slug is accepted as is.`,
    example: 'harry-potter-updated',
    pattern: SLUG_PATTERN,
  })
  // `LEGACY-437`: `null` в `Book.slug` NOT NULL — 500; пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(SLUG_REGEX, { message: `Slug must match the pattern: ${SLUG_PATTERN}` })
  // Предел длины здесь не стоит: DTO не знает текущий слаг, а неизменный слаг старой книги длиннее 100
  // не должен давать 400. Предел держит `BookService.update` — только у изменённого слага (`LEGACY-437`).
  slug?: string;

  // More fields can be added as needed
}
