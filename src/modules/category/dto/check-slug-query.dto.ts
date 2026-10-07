import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, Matches, MaxLength } from 'class-validator';
import {
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_MESSAGE,
  SLUG_PATTERN,
  SLUG_REGEX_README,
} from '../../../shared/validators/slug';

export class CheckCategorySlugQueryDto {
  @ApiProperty({
    description: 'Slug to check for uniqueness',
    example: 'fantasy',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), {
    message: SLUG_REGEX_README,
  })
  @MaxLength(SLUG_MAX_LENGTH, { message: SLUG_MAX_LENGTH_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({
    description: 'Category ID to exclude from the check (when editing)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'excludeId must be a valid UUID' })
  excludeId?: string;
}
