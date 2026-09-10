import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DecidedByUserDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string;
  @ApiProperty() email!: string;
}

export class RightsReviewApprovalDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsReviewId!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty() decision!: string;
  @ApiProperty({ type: DecidedByUserDto, nullable: true })
  decidedByUser!: DecidedByUserDto | null;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty() createdAt!: string;
}
