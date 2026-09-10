import { ApiProperty } from '@nestjs/swagger';

export class CreateBookFromClearanceResponseBookDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  currentRightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsCreatedAt!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String })
  updatedAt!: string;
}

export class CreateBookFromClearanceResponseVersionDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookId!: string;

  @ApiProperty({ type: String })
  language!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsStatus!: string | null;
}

export class CreateBookFromClearanceResponseDto {
  @ApiProperty({ type: CreateBookFromClearanceResponseBookDto })
  book!: CreateBookFromClearanceResponseBookDto;

  @ApiProperty({ type: [CreateBookFromClearanceResponseVersionDto] })
  versions!: CreateBookFromClearanceResponseVersionDto[];

  @ApiProperty({ type: String })
  rightsProfileId!: string;

  @ApiProperty({ type: String })
  approvedRightsReviewId!: string;
}
