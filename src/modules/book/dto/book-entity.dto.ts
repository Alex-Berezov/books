import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response of `PATCH /books/:id` (`BookService.update`) — the full `Book` row
 * returned by `tx.book.update` (no `select`). Unlike `PUBLIC_BOOK_SELECT`, this is
 * the admin-only route (`@Roles(Admin, ContentManager)`), so the internal rights
 * linkage fields are included as-is: they are what the code actually returns.
 */
export class BookEntityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: String, nullable: true })
  rightsIntakeId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  currentRightsProfileId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  rightsCreatedAt!: Date | null;
}
