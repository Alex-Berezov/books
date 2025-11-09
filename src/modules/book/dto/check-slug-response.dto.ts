import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExistingBookDto {
  @ApiProperty({
    description: 'UUID книги',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  id!: string;

  @ApiProperty({
    description: 'Slug книги',
    example: 'harry-potter',
  })
  slug!: string;
}

export class CheckBookSlugResponseDto {
  @ApiProperty({
    description: 'true если slug уже занят',
    example: false,
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Предлагаемый уникальный slug (если exists = true)',
    example: 'harry-potter-2',
  })
  suggestedSlug?: string;

  @ApiPropertyOptional({
    description: 'Информация о существующей книге (если exists = true)',
    type: ExistingBookDto,
  })
  existingBook?: ExistingBookDto;
}
