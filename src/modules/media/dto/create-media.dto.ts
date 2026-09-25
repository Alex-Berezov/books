import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PAGINATION_MAX_LIMIT } from '../../../shared/dto/pagination.dto';

export const MEDIA_CATEGORIES = ['image', 'video', 'audio', 'document'] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];

export class ConfirmMediaDto {
  @ApiProperty({
    description: 'Storage object key (from /uploads)',
    example: 'covers/2025/08/26/uuid.jpg',
  })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({
    description: 'Public URL resolved by storage',
    example: 'http://localhost:3000/static/covers/2025/08/26/uuid.jpg',
  })
  @IsUrl({ require_tld: false })
  url!: string;

  @ApiPropertyOptional({ description: 'Content type (MIME)', example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  contentType?: string;

  @ApiPropertyOptional({ description: 'Size in bytes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;

  @ApiPropertyOptional({ description: 'Width in px (images)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional({ description: 'Height in px (images)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @ApiPropertyOptional({ description: 'Optional content hash for dedupe (e.g., sha256)' })
  @IsOptional()
  @IsString()
  hash?: string;
}

export class MediaListQueryDto {
  @ApiPropertyOptional({ description: 'Search by key substring' })
  @IsOptional()
  @IsString()
  q?: string;
  @ApiPropertyOptional({
    description: 'Filter by media category. `document` matches anything not image/video/audio.',
    enum: MEDIA_CATEGORIES,
  })
  @IsOptional()
  @IsIn(MEDIA_CATEGORIES)
  type?: MediaCategory;

  @ApiPropertyOptional({ description: 'Page', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Limit', default: 20, maximum: PAGINATION_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = 20;
}
