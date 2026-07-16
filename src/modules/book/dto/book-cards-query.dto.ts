import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

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
}
