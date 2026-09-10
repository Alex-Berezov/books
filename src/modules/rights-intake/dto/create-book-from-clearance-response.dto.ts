import { ApiProperty } from '@nestjs/swagger';

export class CreateBookFromClearanceResponseBookDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  currentRightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsCreatedAt!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CreateBookFromClearanceResponseVersionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bookId!: string;

  @ApiProperty()
  language!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsStatus!: string | null;
}

export class CreateBookFromClearanceResponseDto {
  @ApiProperty({ type: CreateBookFromClearanceResponseBookDto })
  book!: CreateBookFromClearanceResponseBookDto;

  @ApiProperty({ type: [CreateBookFromClearanceResponseVersionDto] })
  versions!: CreateBookFromClearanceResponseVersionDto[];

  @ApiProperty()
  rightsProfileId!: string;

  @ApiProperty()
  approvedRightsReviewId!: string;
}
