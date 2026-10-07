import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import {
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_MESSAGE,
  SLUG_PATTERN,
  SLUG_REGEX_README,
} from '../../../shared/validators/slug';

/**
 * Повторяет `CheckCategorySlugQueryDto` по форме, но живёт отдельно намеренно:
 * описания полей попадают в Swagger, и «Category ID to exclude» в разделе тегов
 * вводило бы в заблуждение. Правила валидации при этом общие — `SLUG_PATTERN`.
 */
export class CheckTagSlugQueryDto {
  @ApiProperty({
    description: 'Slug to check for uniqueness',
    example: 'aestheticism',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  @MaxLength(SLUG_MAX_LENGTH, { message: SLUG_MAX_LENGTH_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({
    description: 'Tag ID to exclude from the check (when editing)',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'excludeId must be a valid UUID' })
  excludeId?: string;
}
