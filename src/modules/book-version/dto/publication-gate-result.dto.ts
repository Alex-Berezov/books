import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class PublicationGateReasonDto {
  @ApiProperty({ description: 'Unique reason code' })
  code: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity: 'BLOCKER' | 'WARNING';

  @ApiProperty({ description: 'Russian message for admin UI' })
  messageRu: string;

  @ApiProperty({ required: false })
  messageEn?: string;

  @ApiProperty({ required: false })
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
  @ApiProperty()
  versionId: string;

  @ApiProperty()
  bookId: string;

  @ApiProperty()
  canPublish: boolean;

  @ApiProperty()
  checkedAt: string;

  @ApiProperty({ nullable: true })
  rightsProfileId: string | null;

  @ApiProperty({ nullable: true })
  approvedRightsReviewId: string | null;

  @ApiProperty({ nullable: true })
  rightsStatus: string | null;

  @ApiProperty({ type: [PublicationGateReasonDto] })
  blockingReasons: PublicationGateReasonDto[];

  @ApiProperty({ type: [PublicationGateReasonDto] })
  warnings: PublicationGateReasonDto[];

  @ApiProperty({ nullable: true })
  contentHashBaseline!: string | null;

  @ApiProperty({ nullable: true })
  contentHashCurrent!: string | null;

  @ApiProperty({ nullable: true })
  contentHashMatches!: boolean | null;

  @ApiProperty()
  rightsRecheckRequired!: boolean;

  // Phase 15: license coverage of the markets that require a license
  @ApiProperty({ nullable: true })
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
  @ApiProperty()
  activeClaimsCount!: number;

  @ApiProperty()
  blockingClaimsCount!: number;

  @ApiProperty()
  criticalClaimsCount!: number;

  @ApiProperty()
  overdueClaimsCount!: number;

  @ApiProperty({ type: [String] })
  claimBlockedCountryCodes!: string[];

  @ApiProperty()
  hasWorldwideClaimBlock!: boolean;

  @ApiProperty({ nullable: true })
  worstClaimSeverity!: string | null;

  @ApiProperty({ type: [String] })
  claimIds!: string[];

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
  }
}

export class UpdateRightsGeoBlockDto {
  @ApiProperty()
  @IsBoolean()
  configured!: boolean;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  notesRu?: string | null;
}
