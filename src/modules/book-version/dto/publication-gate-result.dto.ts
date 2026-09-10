import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class PublicationGateReasonDto {
  @ApiProperty({ type: String, description: 'Unique reason code' })
  code: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity: 'BLOCKER' | 'WARNING';

  @ApiProperty({ type: String, description: 'Russian message for admin UI' })
  messageRu: string;

  @ApiProperty({ type: String, required: false })
  messageEn?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;

  constructor(data: {
    code: string;
    severity: 'BLOCKER' | 'WARNING';
    messageRu: string;
    messageEn?: string;
    details?: Record<string, unknown>;
  }) {
    this.code = data.code;
    this.severity = data.severity;
    this.messageRu = data.messageRu;
    this.messageEn = data.messageEn;
    this.details = data.details;
  }
}

export class PublicationGateResultDto {
  @ApiProperty({ type: String })
  versionId: string;

  @ApiProperty({ type: String })
  bookId: string;

  @ApiProperty({ type: Boolean })
  canPublish: boolean;

  @ApiProperty({ type: String })
  checkedAt: string;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsStatus: string | null;

  @ApiProperty({ type: [PublicationGateReasonDto] })
  blockingReasons: PublicationGateReasonDto[];

  @ApiProperty({ type: [PublicationGateReasonDto] })
  warnings: PublicationGateReasonDto[];

  // WP-H: стадия подготовки. Поля добавлены аддитивно, `canPublish` и `blockingReasons`
  // по-прежнему отвечают только на вопрос о публикации и ни на один код не ослаблены.
  @ApiProperty({
    description:
      'Можно ли готовить материал версии, пока публикация ещё закрыта. Публикацию не разрешает.',
  })
  canPrepare!: boolean;

  @ApiProperty({
    type: [PublicationGateReasonDto],
    description: 'Подмножество blockingReasons, запрещающее даже подготовку материала.',
  })
  preparationBlockingReasons!: PublicationGateReasonDto[];

  @ApiProperty({ type: String, nullable: true })
  contentHashBaseline!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contentHashCurrent!: string | null;

  @ApiProperty({ type: Boolean, nullable: true })
  contentHashMatches!: boolean | null;

  @ApiProperty({ type: Boolean })
  rightsRecheckRequired!: boolean;

  // Phase 15: license coverage of the markets that require a license
  @ApiProperty({ type: String, nullable: true })
  licenseCoverageStatus!: string | null;

  @ApiProperty({ type: [String] })
  licenseRequiredCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  licenseCoveredCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  licenseUncoveredCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  licenseIds!: string[];

  // Phase 16: rights claims / DMCA
  @ApiProperty({ type: Number })
  activeClaimsCount!: number;

  @ApiProperty({ type: Number })
  blockingClaimsCount!: number;

  @ApiProperty({ type: Number })
  criticalClaimsCount!: number;

  @ApiProperty({ type: Number })
  overdueClaimsCount!: number;

  @ApiProperty({ type: [String] })
  claimBlockedCountryCodes!: string[];

  @ApiProperty({ type: Boolean })
  hasWorldwideClaimBlock!: boolean;

  @ApiProperty({ type: String, nullable: true })
  worstClaimSeverity!: string | null;

  @ApiProperty({ type: [String] })
  claimIds!: string[];

  // Phase 18: automatic recheck
  @ApiProperty({ type: Number })
  openRecheckTasksCount!: number;

  @ApiProperty({ type: Number })
  overdueRecheckTasksCount!: number;

  @ApiProperty({ type: Number })
  blockingRecheckTasksCount!: number;

  @ApiProperty({ type: String, nullable: true })
  nextRecheckDueAt!: string | null;

  @ApiProperty({ type: [String] })
  recheckTaskIds!: string[];

  // Phase 19: lawyer workflow. All optional — existing fields and codes are untouched.
  @ApiProperty({ type: Boolean })
  lawyerReviewRequired!: boolean;

  @ApiProperty({ type: Boolean })
  lawyerApproved!: boolean;

  @ApiProperty({ type: Number })
  openLawyerReviewsCount!: number;

  @ApiProperty({ type: Number })
  pendingLawyerConditionsCount!: number;

  @ApiProperty({ type: String, nullable: true })
  riskLevel!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lawyerOpinionValidUntil!: string | null;

  @ApiProperty({ type: [String] })
  lawyerReviewIds!: string[];

  constructor(data: {
    versionId: string;
    bookId: string;
    canPublish: boolean;
    checkedAt: string;
    rightsProfileId: string | null;
    approvedRightsReviewId: string | null;
    rightsStatus: string | null;
    blockingReasons: PublicationGateReasonDto[];
    warnings: PublicationGateReasonDto[];
    canPrepare?: boolean;
    preparationBlockingReasons?: PublicationGateReasonDto[];
    contentHashBaseline?: string | null;
    contentHashCurrent?: string | null;
    contentHashMatches?: boolean | null;
    rightsRecheckRequired?: boolean;
    licenseCoverageStatus?: string | null;
    licenseRequiredCountryCodes?: string[];
    licenseCoveredCountryCodes?: string[];
    licenseUncoveredCountryCodes?: string[];
    licenseIds?: string[];
    activeClaimsCount?: number;
    blockingClaimsCount?: number;
    criticalClaimsCount?: number;
    overdueClaimsCount?: number;
    claimBlockedCountryCodes?: string[];
    hasWorldwideClaimBlock?: boolean;
    worstClaimSeverity?: string | null;
    claimIds?: string[];
    openRecheckTasksCount?: number;
    overdueRecheckTasksCount?: number;
    blockingRecheckTasksCount?: number;
    nextRecheckDueAt?: string | null;
    recheckTaskIds?: string[];
    lawyerReviewRequired?: boolean;
    lawyerApproved?: boolean;
    openLawyerReviewsCount?: number;
    pendingLawyerConditionsCount?: number;
    riskLevel?: string | null;
    lawyerOpinionValidUntil?: string | null;
    lawyerReviewIds?: string[];
  }) {
    this.versionId = data.versionId;
    this.bookId = data.bookId;
    this.canPublish = data.canPublish;
    this.checkedAt = data.checkedAt;
    this.rightsProfileId = data.rightsProfileId;
    this.approvedRightsReviewId = data.approvedRightsReviewId;
    this.rightsStatus = data.rightsStatus;
    this.blockingReasons = data.blockingReasons;
    this.warnings = data.warnings;
    // Fail-closed: не переданная стадия подготовки означает «не разрешено», а не «разрешено».
    this.canPrepare = data.canPrepare ?? false;
    this.preparationBlockingReasons = data.preparationBlockingReasons ?? data.blockingReasons;
    this.contentHashBaseline = data.contentHashBaseline ?? null;
    this.contentHashCurrent = data.contentHashCurrent ?? null;
    this.contentHashMatches = data.contentHashMatches ?? null;
    this.rightsRecheckRequired = data.rightsRecheckRequired ?? false;
    this.licenseCoverageStatus = data.licenseCoverageStatus ?? null;
    this.licenseRequiredCountryCodes = data.licenseRequiredCountryCodes ?? [];
    this.licenseCoveredCountryCodes = data.licenseCoveredCountryCodes ?? [];
    this.licenseUncoveredCountryCodes = data.licenseUncoveredCountryCodes ?? [];
    this.licenseIds = data.licenseIds ?? [];
    this.activeClaimsCount = data.activeClaimsCount ?? 0;
    this.blockingClaimsCount = data.blockingClaimsCount ?? 0;
    this.criticalClaimsCount = data.criticalClaimsCount ?? 0;
    this.overdueClaimsCount = data.overdueClaimsCount ?? 0;
    this.claimBlockedCountryCodes = data.claimBlockedCountryCodes ?? [];
    this.hasWorldwideClaimBlock = data.hasWorldwideClaimBlock ?? false;
    this.worstClaimSeverity = data.worstClaimSeverity ?? null;
    this.claimIds = data.claimIds ?? [];
    this.openRecheckTasksCount = data.openRecheckTasksCount ?? 0;
    this.overdueRecheckTasksCount = data.overdueRecheckTasksCount ?? 0;
    this.blockingRecheckTasksCount = data.blockingRecheckTasksCount ?? 0;
    this.nextRecheckDueAt = data.nextRecheckDueAt ?? null;
    this.recheckTaskIds = data.recheckTaskIds ?? [];
    this.lawyerReviewRequired = data.lawyerReviewRequired ?? false;
    this.lawyerApproved = data.lawyerApproved ?? false;
    this.openLawyerReviewsCount = data.openLawyerReviewsCount ?? 0;
    this.pendingLawyerConditionsCount = data.pendingLawyerConditionsCount ?? 0;
    this.riskLevel = data.riskLevel ?? null;
    this.lawyerOpinionValidUntil = data.lawyerOpinionValidUntil ?? null;
    this.lawyerReviewIds = data.lawyerReviewIds ?? [];
  }
}

export class UpdateRightsGeoBlockDto {
  @ApiProperty()
  @IsBoolean()
  configured!: boolean;

  @ApiProperty({ type: String, required: false, nullable: true })
  @IsOptional()
  @IsString()
  notesRu?: string | null;
}
