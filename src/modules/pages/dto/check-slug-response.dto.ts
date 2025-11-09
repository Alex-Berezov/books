import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicationStatus } from '@prisma/client';

export class ExistingPageDto {
  @ApiProperty({
    description: 'UUID страницы',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id!: string;

  @ApiProperty({
    description: 'Название страницы',
    example: 'About Us',
  })
  title!: string;

  @ApiProperty({
    description: 'Статус публикации',
    enum: PublicationStatus,
    example: 'published',
  })
  status!: PublicationStatus;
}

export class CheckPageSlugResponseDto {
  @ApiProperty({
    description: 'true если slug уже занят',
    example: false,
  })
  exists!: boolean;

  @ApiPropertyOptional({
    description: 'Предлагаемый уникальный slug (если exists = true)',
    example: 'about-us-2',
  })
  suggestedSlug?: string;

  @ApiPropertyOptional({
    description: 'Информация о существующей странице (если exists = true)',
    type: ExistingPageDto,
  })
  existingPage?: ExistingPageDto;
}
