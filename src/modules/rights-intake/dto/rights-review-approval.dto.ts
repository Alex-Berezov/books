import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RightsApprovalDecision } from '@prisma/client';

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
  @ApiProperty({ enum: RightsApprovalDecision })
  decision!: RightsApprovalDecision;
  @ApiProperty({ type: DecidedByUserDto, nullable: true })
  decidedByUser!: DecidedByUserDto | null;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty() createdAt!: string;
}
