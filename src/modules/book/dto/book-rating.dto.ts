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
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  bookId!: string;

  @ApiProperty({ description: 'Score from 1 to 5' })
  score!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
