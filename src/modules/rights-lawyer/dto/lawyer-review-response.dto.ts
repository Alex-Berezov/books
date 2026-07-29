import { ApiProperty } from '@nestjs/swagger';
import {
  RightsLawyerConditionStatus,
  RightsLawyerDecision,
  RightsLawyerReviewEventType,
  RightsLawyerReviewStatus,
  RightsLawyerReviewTrigger,
  RightsLegalOpinionKind,
  RightsRiskFactorCode,
  RightsRiskLevel,
} from '../rights-lawyer-interface';

export class RiskFactorDto {
  @ApiProperty({ enum: RightsRiskFactorCode }) code!: RightsRiskFactorCode;
  @ApiProperty({ enum: RightsRiskLevel }) level!: RightsRiskLevel;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ nullable: true, type: Object }) details!: Record<string, unknown> | null;
}

export class LawyerConditionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsLawyerReviewId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() textRu!: string;
  @ApiProperty({ enum: RightsLawyerConditionStatus }) status!: RightsLawyerConditionStatus;
  @ApiProperty() isBlocking!: boolean;
  @ApiProperty({ type: [String] }) affectedCountryCodes!: string[];
  @ApiProperty({ nullable: true }) satisfiedAt!: string | null;
  @ApiProperty({ nullable: true }) satisfiedNotesRu!: string | null;
  @ApiProperty({ nullable: true }) waivedAt!: string | null;
  @ApiProperty({ nullable: true }) waiveReasonRu!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LegalOpinionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsLawyerReviewId!: string;
  @ApiProperty({ enum: RightsLegalOpinionKind }) kind!: RightsLegalOpinionKind;
  @ApiProperty() titleRu!: string;
  @ApiProperty() bodyRu!: string;
  @ApiProperty({ nullable: true }) lawyerId!: string | null;
  @ApiProperty({ nullable: true }) lawyerNameSnapshot!: string | null;
  @ApiProperty({ nullable: true }) documentUrl!: string | null;
  @ApiProperty({ nullable: true }) documentSha256!: string | null;
  @ApiProperty({ nullable: true }) fileName!: string | null;
  @ApiProperty({ nullable: true }) mimeType!: string | null;
  @ApiProperty({ nullable: true }) issuedAt!: string | null;
  @ApiProperty({ type: [String] }) jurisdictionCodes!: string[];
  /** Доказательство типа LEGAL_OPINION, созданное автоматически при прикреплении. */
  @ApiProperty({ nullable: true }) rightsEvidenceId!: string | null;
  @ApiProperty({ nullable: true }) archivedAt!: string | null;
  @ApiProperty({ nullable: true }) archiveReasonRu!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LawyerReviewEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsLawyerReviewEventType }) eventType!: RightsLawyerReviewEventType;
  @ApiProperty({ enum: RightsLawyerReviewStatus, nullable: true })
  fromStatus!: RightsLawyerReviewStatus | null;
  @ApiProperty({ enum: RightsLawyerReviewStatus, nullable: true })
  toStatus!: RightsLawyerReviewStatus | null;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ nullable: true, type: Object }) payload!: Record<string, unknown> | null;
  @ApiProperty({ nullable: true }) createdByUserId!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LawyerReviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() reviewNumber!: string;
  @ApiProperty({ enum: RightsLawyerReviewStatus }) status!: RightsLawyerReviewStatus;
  /**
   * `EXPIRED`, если срок действия положительного заключения уже прошёл, даже когда в БД
   * всё ещё записан `APPROVED`. Тот же приём, что `effectiveStatus` у лицензий фазы 15.
   */
  @ApiProperty({ enum: RightsLawyerReviewStatus }) effectiveStatus!: RightsLawyerReviewStatus;
  @ApiProperty({ enum: RightsLawyerReviewTrigger }) trigger!: RightsLawyerReviewTrigger;
  @ApiProperty({ enum: RightsRiskLevel }) riskLevel!: RightsRiskLevel;
  @ApiProperty({ nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ nullable: true }) rightsIntakeId!: string | null;
  @ApiProperty({ nullable: true }) rightsReviewId!: string | null;
  @ApiProperty({ nullable: true }) bookId!: string | null;
  @ApiProperty({ nullable: true }) bookVersionId!: string | null;
  @ApiProperty({ nullable: true }) rightsClaimId!: string | null;
  @ApiProperty() titleRu!: string;
  @ApiProperty() questionRu!: string;
  @ApiProperty({ nullable: true }) contextRu!: string | null;
  @ApiProperty({ type: [String] }) affectedCountryCodes!: string[];
  @ApiProperty({ type: [String] }) affectedLanguages!: string[];
  @ApiProperty({ type: [String] }) affectedComponentIds!: string[];
  @ApiProperty() blocksApproval!: boolean;
  @ApiProperty({ nullable: true }) requestedByUserId!: string | null;
  @ApiProperty() requestedAt!: string;
  @ApiProperty({ nullable: true }) dueAt!: string | null;
  @ApiProperty({ nullable: true }) assignedLawyerId!: string | null;
  @ApiProperty({ nullable: true }) assignedLawyerName!: string | null;
  @ApiProperty({ nullable: true }) assignedAt!: string | null;
  @ApiProperty({ nullable: true }) startedAt!: string | null;
  @ApiProperty({ enum: RightsLawyerDecision, nullable: true })
  decision!: RightsLawyerDecision | null;
  @ApiProperty({ nullable: true }) decidedAt!: string | null;
  @ApiProperty({ nullable: true }) decidedByUserId!: string | null;
  @ApiProperty({ nullable: true }) decidedLawyerId!: string | null;
  /** Имя юриста на момент решения — приоритетно для отображения истории. */
  @ApiProperty({ nullable: true }) lawyerNameSnapshot!: string | null;
  @ApiProperty({ nullable: true }) opinionSummaryRu!: string | null;
  @ApiProperty({ nullable: true }) restrictionsRu!: string | null;
  @ApiProperty({ type: [String] }) approvedCountryCodes!: string[];
  @ApiProperty({ type: [String] }) blockedCountryCodes!: string[];
  @ApiProperty({ nullable: true }) validUntil!: string | null;
  @ApiProperty({ nullable: true }) expiredAt!: string | null;
  @ApiProperty({ nullable: true }) withdrawnAt!: string | null;
  @ApiProperty({ nullable: true }) withdrawReasonRu!: string | null;
  @ApiProperty({ nullable: true }) reopenedAt!: string | null;

  @ApiProperty() isOverdue!: boolean;
  @ApiProperty({ nullable: true }) daysUntilDue!: number | null;
  @ApiProperty({ nullable: true }) daysUntilExpiry!: number | null;
  @ApiProperty() isExpiringSoon!: boolean;
  @ApiProperty() blocksPublication!: boolean;
  @ApiProperty() pendingConditionsCount!: number;
  @ApiProperty() blockingConditionsCount!: number;
  @ApiProperty() satisfiedConditionsCount!: number;
  @ApiProperty() opinionsCount!: number;
  @ApiProperty() activeOpinionsCount!: number;

  @ApiProperty({ nullable: true }) intakeTitle!: string | null;
  @ApiProperty({ nullable: true }) bookSlug!: string | null;
  @ApiProperty({ nullable: true }) versionLanguage!: string | null;

  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class LawyerReviewDetailDto extends LawyerReviewDto {
  @ApiProperty({ type: [LawyerConditionDto] }) conditions!: LawyerConditionDto[];
  @ApiProperty({ type: [LegalOpinionDto] }) opinions!: LegalOpinionDto[];
  @ApiProperty({ type: [LawyerReviewEventDto] }) events!: LawyerReviewEventDto[];
  @ApiProperty({ type: [RiskFactorDto] }) riskFactors!: RiskFactorDto[];
}

export class LawyerReviewListResponseDto {
  @ApiProperty({ type: [LawyerReviewDto] }) items!: LawyerReviewDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
