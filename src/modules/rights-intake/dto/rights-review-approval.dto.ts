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
  @ApiProperty({ type: DecidedByUserDto })
  decidedByUser!: DecidedByUserDto | null;
  @ApiPropertyOptional() notesRu?: string | null;
  @ApiProperty() createdAt!: string;
}
