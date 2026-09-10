import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Ручка отвечает двумя формами одного объекта: `{ exists: false }`, когда слаг
 * свободен, и `{ exists: true, existingAuthor: { id, slug } }`, когда занят
 * (`author.controller.ts`). Формы отличаются только наличием `existingAuthor`,
 * поэтому описаны одним классом с необязательным полем — так же, как у книг
 * (`book/dto/check-slug-response.dto.ts`) и категорий.
 *
 * Поля `suggestedSlug` у авторов нет: контроллер его не собирает.
 */
export class ExistingAuthorDto {
  @ApiProperty({
    description: 'Author UUID',
    example: '770e8400-e29b-41d4-a716-446655440002',
  })
  id!: string;

  @ApiProperty({
    description: 'Author slug in the requested language',
    example: 'stephen-king',
  })
  slug!: string;
}

export class CheckAuthorSlugResponseDto {
  @ApiProperty({
    description: 'true if the slug is already taken',
    example: false,
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Information about the existing author (if exists = true)',
    type: ExistingAuthorDto,
  })
  existingAuthor?: ExistingAuthorDto;
}
