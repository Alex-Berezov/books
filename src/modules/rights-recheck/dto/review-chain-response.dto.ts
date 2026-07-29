import { ApiProperty } from '@nestjs/swagger';

/** What changed between a review and the one before it in the chain. */
export class ReviewChainDiffDto {
  @ApiProperty() overallStatusChanged!: boolean;
  @ApiProperty() publicationGateChanged!: boolean;
  @ApiProperty() confidenceChanged!: boolean;
  @ApiProperty() changedCountryCount!: number;
}

export class ReviewChainItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() revisionNumber!: number;
  @ApiProperty({ nullable: true }) previousReviewId!: string | null;
  @ApiProperty({ nullable: true }) chainRootReviewId!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty({ nullable: true }) nextReviewAt!: string | null;
  @ApiProperty({ nullable: true }) approvedAt!: string | null;
  @ApiProperty({ nullable: true }) approvedByUserId!: string | null;
  @ApiProperty({ nullable: true }) approvedByUserName!: string | null;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() rightsReviewImportId!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: ReviewChainDiffDto, nullable: true })
  diffFromPrevious!: ReviewChainDiffDto | null;
}

export class ReviewChainResponseDto {
  @ApiProperty({ type: [ReviewChainItemDto] }) items!: ReviewChainItemDto[];
  @ApiProperty() total!: number;
}
