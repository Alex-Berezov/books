import { ApiProperty } from '@nestjs/swagger';
import { LawyerConditionDto, LawyerReviewDto } from './lawyer-review-response.dto';
import { RightsRiskLevel } from '../rights-lawyer-interface';

/** One publication-gate contribution of the lawyer module. */
export class LawyerGateReasonDto {
  @ApiProperty() code!: string;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ nullable: true }) lawyerReviewId!: string | null;
  @ApiProperty({ nullable: true, type: Object }) details!: Record<string, unknown> | null;
}

/** What `evaluateVersionLawyerReview` hands to the publication gate. Nothing is written. */
export class LawyerGateEvaluationDto {
  @ApiProperty() versionId!: string;
  @ApiProperty({ type: [LawyerGateReasonDto] }) blockers!: LawyerGateReasonDto[];
  @ApiProperty({ type: [LawyerGateReasonDto] }) warnings!: LawyerGateReasonDto[];
  @ApiProperty() lawyerReviewRequired!: boolean;
  @ApiProperty() lawyerApproved!: boolean;
  @ApiProperty() openReviewsCount!: number;
  @ApiProperty() pendingConditionsCount!: number;
  @ApiProperty({ enum: RightsRiskLevel, nullable: true }) riskLevel!: RightsRiskLevel | null;
  @ApiProperty({ nullable: true }) lawyerOpinionValidUntil!: string | null;
  @ApiProperty({ type: [String] }) reviewIds!: string[];
}

export class VersionLawyerReviewDto extends LawyerGateEvaluationDto {
  @ApiProperty({ nullable: true }) bookId!: string | null;
  @ApiProperty({ nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ nullable: true }) lawyerApprovedAt!: string | null;
  @ApiProperty({ nullable: true }) lawyerApprovedLawyerName!: string | null;
  @ApiProperty() isExpiringSoon!: boolean;
  @ApiProperty({ type: [LawyerReviewDto] }) reviews!: LawyerReviewDto[];
  @ApiProperty({ type: [LawyerConditionDto] }) pendingConditions!: LawyerConditionDto[];
}

export class LawyerExpiryScanResultDto {
  @ApiProperty() checkedCount!: number;
  @ApiProperty() expiredCount!: number;
  @ApiProperty() expiringSoonCount!: number;
  @ApiProperty() notificationsSent!: number;
  @ApiProperty({ type: [String] }) reviewIds!: string[];
  @ApiProperty() runAt!: string;
}
