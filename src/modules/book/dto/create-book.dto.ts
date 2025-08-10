import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreateBookDto {
  @ApiProperty({
    description: `Уникальный slug книги. ${SLUG_REGEX_README}`,
    example: 'harry-potter',
    pattern: SLUG_PATTERN,
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(SLUG_REGEX, { message: `Slug должен соответствовать паттерну: ${SLUG_PATTERN}` })
  slug: string;

  // More fields can be added as needed
}
