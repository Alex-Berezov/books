import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicationStatus } from '@prisma/client';

export class ExistingPageDto {
  @ApiProperty({
    description: 'Page UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id!: string;

  @ApiProperty({
    description: 'Page title',
    example: 'About Us',
  })
  title!: string;

  @ApiProperty({
    description: 'Publication status',
    enum: PublicationStatus,
    example: 'published',
  })
  status!: PublicationStatus;
}

export class CheckPageSlugResponseDto {
  @ApiProperty({
    description: 'true if the slug is already taken',
    example: false,
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Suggested unique slug (if exists = true)',
    example: 'about-us-2',
  })
  suggestedSlug?: string;

  @ApiPropertyOptional({
    description: 'Information about the existing page (if exists = true)',
    type: ExistingPageDto,
  })
  existingPage?: ExistingPageDto;
}
