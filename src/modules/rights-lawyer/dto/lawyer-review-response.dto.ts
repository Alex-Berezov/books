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
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Free-form by design: each `RightsRiskFactorCode` carries its own keys, copied through by `RightsRiskAssessmentService` (`details: factor.details ?? null`) without a shared shape.',
  })
  details!: Record<string, unknown> | null;
}

export class LawyerConditionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsLawyerReviewId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() textRu!: string;
  @ApiProperty({ enum: RightsLawyerConditionStatus }) status!: RightsLawyerConditionStatus;
  @ApiProperty() isBlocking!: boolean;
  @ApiProperty({ type: [String] }) affectedCountryCodes!: string[];
  @ApiProperty({ type: String, nullable: true }) satisfiedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) satisfiedNotesRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) waivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) waiveReasonRu!: string | null;
  @ApiProperty() createdAt!: string;
}

export class LegalOpinionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsLawyerReviewId!: string;
  @ApiProperty({ enum: RightsLegalOpinionKind }) kind!: RightsLegalOpinionKind;
  @ApiProperty() titleRu!: string;
  @ApiProperty() bodyRu!: string;
  @ApiProperty({ type: String, nullable: true }) lawyerId!: string | null;
  @ApiProperty({ type: String, nullable: true }) lawyerNameSnapshot!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) fileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) mimeType!: string | null;
  @ApiProperty({ type: String, nullable: true }) issuedAt!: string | null;
  @ApiProperty({ type: [String] }) jurisdictionCodes!: string[];
  /** Доказательство типа LEGAL_OPINION, созданное автоматически при прикреплении. */
  @ApiProperty({ type: String, nullable: true }) rightsEvidenceId!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archiveReasonRu!: string | null;
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
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Free-form by design: each `RightsLawyerReviewEventType` writes its own keys (`{ trigger, riskLevel, blocksApproval }`, `{ lawyerId, lawyerName }`, `{ conditionId, code }`, `{ reviewNumber, withdrawReasonRu }`, …). `appendEvent` takes `payload: unknown`.',
  })
  payload!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) createdByUserId!: string | null;
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
  @ApiProperty({ type: String, nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsIntakeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) bookId!: string | null;
  @ApiProperty({ type: String, nullable: true }) bookVersionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsClaimId!: string | null;
  @ApiProperty() titleRu!: string;
  @ApiProperty() questionRu!: string;
  @ApiProperty({ type: String, nullable: true }) contextRu!: string | null;
  @ApiProperty({ type: [String] }) affectedCountryCodes!: string[];
  @ApiProperty({ type: [String] }) affectedLanguages!: string[];
  @ApiProperty({ type: [String] }) affectedComponentIds!: string[];
  @ApiProperty() blocksApproval!: boolean;
  @ApiProperty({ type: String, nullable: true }) requestedByUserId!: string | null;
  @ApiProperty() requestedAt!: string;
  @ApiProperty({ type: String, nullable: true }) dueAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) assignedLawyerId!: string | null;
  @ApiProperty({ type: String, nullable: true }) assignedLawyerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) assignedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) startedAt!: string | null;
  @ApiProperty({ enum: RightsLawyerDecision, nullable: true })
  decision!: RightsLawyerDecision | null;
  @ApiProperty({ type: String, nullable: true }) decidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) decidedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) decidedLawyerId!: string | null;
  /** Имя юриста на момент решения — приоритетно для отображения истории. */
  @ApiProperty({ type: String, nullable: true }) lawyerNameSnapshot!: string | null;
  @ApiProperty({ type: String, nullable: true }) opinionSummaryRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) restrictionsRu!: string | null;
  @ApiProperty({ type: [String] }) approvedCountryCodes!: string[];
  @ApiProperty({ type: [String] }) blockedCountryCodes!: string[];
  @ApiProperty({ type: String, nullable: true }) validUntil!: string | null;
  @ApiProperty({ type: String, nullable: true }) expiredAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) withdrawnAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) withdrawReasonRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) reopenedAt!: string | null;

  @ApiProperty() isOverdue!: boolean;
  @ApiProperty({ type: Number, nullable: true }) daysUntilDue!: number | null;
  @ApiProperty({ type: Number, nullable: true }) daysUntilExpiry!: number | null;
  @ApiProperty() isExpiringSoon!: boolean;
  @ApiProperty() blocksPublication!: boolean;
  @ApiProperty() pendingConditionsCount!: number;
  @ApiProperty() blockingConditionsCount!: number;
  @ApiProperty() satisfiedConditionsCount!: number;
  @ApiProperty() opinionsCount!: number;
  @ApiProperty() activeOpinionsCount!: number;

  @ApiProperty({ type: String, nullable: true }) intakeTitle!: string | null;
  @ApiProperty({ type: String, nullable: true }) bookSlug!: string | null;
  @ApiProperty({ type: String, nullable: true }) versionLanguage!: string | null;

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
