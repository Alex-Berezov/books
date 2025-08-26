import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Min } from 'class-validator';
import { Type } from 'class-transformer';

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
  @ApiPropertyOptional({ description: 'Filter by content type prefix (e.g., image/, audio/)' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Page', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Limit', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
