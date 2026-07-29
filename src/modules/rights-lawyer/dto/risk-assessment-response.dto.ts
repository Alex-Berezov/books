import { ApiProperty } from '@nestjs/swagger';
import { LawyerReviewDto, RiskFactorDto } from './lawyer-review-response.dto';
import { RightsLawyerReviewTrigger, RightsRiskLevel } from '../rights-lawyer-interface';

export class RiskAssessmentSnapshotDto {
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty({ enum: RightsRiskLevel }) riskLevel!: RightsRiskLevel;
  @ApiProperty({ type: [RiskFactorDto] }) factors!: RiskFactorDto[];
  @ApiProperty() lawyerReviewRequired!: boolean;
  /** Значение `RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK` на момент оценки. */
  @ApiProperty() blockApprovalEnabled!: boolean;
  @ApiProperty({ enum: RightsRiskLevel }) minRiskLevel!: RightsRiskLevel;
  @ApiProperty({ nullable: true }) assessedAt!: string | null;
  @ApiProperty({ type: LawyerReviewDto, nullable: true })
  currentLawyerReview!: LawyerReviewDto | null;
  @ApiProperty() explicitLawyerRequest!: boolean;
  @ApiProperty({ enum: RightsLawyerReviewTrigger })
  suggestedTrigger!: RightsLawyerReviewTrigger;
  /** Действует ли положительное заключение прямо сейчас. */
  @ApiProperty() lawyerApproved!: boolean;
  @ApiProperty({ nullable: true }) lawyerApprovedAt!: string | null;
  @ApiProperty({ nullable: true }) lawyerApprovedLawyerName!: string | null;
  @ApiProperty({ nullable: true }) lawyerOpinionValidUntil!: string | null;
}
