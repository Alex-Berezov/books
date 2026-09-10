import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

/** Response of `GET /books/:id/my-rating` (`BookService.getUserRating`). */
export class BookRatingScoreDto {
  @ApiPropertyOptional({
    type: Number,
    description: 'User rating score (1-5), null if not rated',
    nullable: true,
  })
  score!: number | null;
}

/**
 * Response of `POST /books/:id/rate` (`BookService.rateBook`) — the full `BookRating`
 * row returned by `prisma.bookRating.upsert` (no `select`).
 */
export class BookRatingDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  userId!: string;

  @ApiProperty({ type: String })
  bookId!: string;

  @ApiProperty({ type: Number, description: 'Score from 1 to 5' })
  score!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
