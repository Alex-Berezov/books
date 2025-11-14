import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExistingBookDto {
  @ApiProperty({
    description: 'Book UUID',
    example: '660e8400-e29b-41d4-a716-446655440001',
  })
  id!: string;

  @ApiProperty({
    description: 'Book slug',
    example: 'harry-potter',
  })
  slug!: string;
}

export class CheckBookSlugResponseDto {
  @ApiProperty({
    description: 'true if the slug is already taken',
    example: false,
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Suggested unique slug (if exists = true)',
    example: 'harry-potter-2',
  })
  suggestedSlug?: string;

  @ApiPropertyOptional({
    description: 'Information about the existing book (if exists = true)',
    type: ExistingBookDto,
  })
  existingBook?: ExistingBookDto;
}
