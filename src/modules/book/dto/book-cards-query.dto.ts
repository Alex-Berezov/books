import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max, IsBoolean, IsString, IsIn } from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Query DTO for compact books-cards endpoint.
 *
 * `limit` default 24, server-side max 48 — prevents the legacy `limit=100`
 * over-fetch from recurring as the catalog grows.
 */
export class BookCardsQueryDto {
  @ApiProperty({ description: 'Page number', example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({
    description: 'Number of cards per page. Default 24, max 48.',
    example: 24,
    default: 24,
    minimum: 1,
    maximum: 48,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  limit?: number = 24;

  @ApiProperty({
    description:
      'Include tag details in response. Default false — returns tag: null for card-only use cases.',
    example: false,
    default: false,
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeTag?: boolean = false;

  @ApiProperty({
    description: 'Sort order. "popular" = rating desc, publishedAt desc. "new" = publishedAt desc.',
    example: 'popular',
    required: false,
    enum: ['popular', 'new'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['popular', 'new'])
  sort?: string;

  @ApiProperty({
    description:
      'Filter by content type. "audio" = has audio chapters, "text" = has text chapters.',
    example: 'audio',
    required: false,
    enum: ['audio', 'text'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['audio', 'text'])
  type?: string;

  @ApiProperty({
    description: 'Search query by title or author (case-insensitive contains).',
    example: 'hamlet',
    required: false,
  })
  @IsOptional()
  @IsString()
  q?: string;
}
