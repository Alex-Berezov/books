import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query DTO for related-books endpoint.
 *
 * `limit` is the MAXIMUM TOTAL number of unique cards across both blocks
 * (sameAuthor + similar). Default 8, max 16.
 */
export class RelatedBooksQueryDto {
  @ApiProperty({
    description: 'Maximum total number of unique cards (sameAuthor + similar). Default 8, max 16.',
    example: 8,
    default: 8,
    minimum: 1,
    maximum: 16,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(16)
  limit?: number = 8;
}
