import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExistingTagDto {
  @ApiProperty({
    description: 'Tag UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id!: string;

  @ApiProperty({ description: 'Tag name', example: 'Aestheticism' })
  name!: string;

  @ApiProperty({ description: 'Tag slug', example: 'aestheticism' })
  slug!: string;
}

/**
 * Форма ответа намеренно повторяет `CheckCategorySlugResponseDto` (LEGACY-061).
 *
 * До 09.08.2026 своей проверки у тегов не было вовсе, и форма тегов в админке
 * проверяла слаг **по книгам** (`entityType="book" // Fallback`) — то есть отвечала
 * на другой вопрос и молчала о настоящих совпадениях.
 */
export class CheckTagSlugResponseDto {
  @ApiProperty({ description: 'true if the slug is already taken', example: false })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Suggested unique slug (if exists = true)',
    example: 'aestheticism-2',
  })
  suggestedSlug?: string;

  @ApiPropertyOptional({
    description: 'Information about the existing tag (if exists = true)',
    type: ExistingTagDto,
  })
  existingTag?: ExistingTagDto;
}
