import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { SLUG_PATTERN, SLUG_REGEX, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class UpdateBookDto {
  @ApiPropertyOptional({
    description: `Unique book slug. ${SLUG_REGEX_README}`,
    example: 'harry-potter-updated',
    pattern: SLUG_PATTERN,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(SLUG_REGEX, { message: `Slug must match the pattern: ${SLUG_PATTERN}` })
  slug?: string;

  // More fields can be added as needed
}
