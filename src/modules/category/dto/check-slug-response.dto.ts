import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExistingCategoryDto {
  @ApiProperty({
    description: 'Category UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id!: string;

  @ApiProperty({
    description: 'Category name',
    example: 'Fantasy',
  })
  name!: string;

  @ApiProperty({
    description: 'Category slug',
    example: 'fantasy',
  })
  slug!: string;
}

export class CheckCategorySlugResponseDto {
  @ApiProperty({
    description: 'true if the slug is already taken',
    example: false,
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Suggested unique slug (if exists = true)',
    example: 'fantasy-2',
  })
  suggestedSlug?: string;

  @ApiPropertyOptional({
    description: 'Information about the existing category (if exists = true)',
    type: ExistingCategoryDto,
  })
  existingCategory?: ExistingCategoryDto;
}
