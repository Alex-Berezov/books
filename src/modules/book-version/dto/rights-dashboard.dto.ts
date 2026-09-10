import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GeoCountrySourceHealthDto } from '../../geo-block/dto/geo-block.dto';
import { PublicationGateResultDto } from './publication-gate-result.dto';
import { RightsContentHashCheckDto } from '../../rights-intake/dto/rights-content-hash.dto';
import { RightsClaimSummaryDto } from '../../rights-claims/dto/rights-claim-response.dto';
import {
  RecheckScheduleDto,
  RecheckTaskDto,
} from '../../rights-recheck/dto/recheck-task-response.dto';
import {
  LawyerConditionDto,
  LawyerReviewDto,
} from '../../rights-lawyer/dto/lawyer-review-response.dto';

export class BookRightsDashboardBookSummaryDto {
  @ApiProperty({ type: String, example: 'a1111111-b222-4c33-d444-555555555555' })
  id!: string;

  @ApiProperty({ type: String, example: 'the-odyssey' })
  slug!: string;

  @ApiProperty({ type: String, nullable: true, example: 'intake-uuid' })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'profile-uuid' })
  currentRightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'review-uuid' })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsCreatedAt!: string | null;
}

export class BookRightsDashboardVersionSummaryDto {
  @ApiProperty({ type: String, example: 'v1111111-b222-4c33-d444-555555555555' })
  id!: string;

  @ApiProperty({ type: String, example: 'en' })
  language!: string;

  @ApiProperty({ type: String, example: 'text' })
  type!: string;

  @ApiProperty({ type: String, example: 'published' })
  status!: string;

  @ApiPropertyOptional({ type: String, example: 'The Odyssey' })
  title?: string;

  @ApiProperty({ type: String, nullable: true, example: 'profile-uuid' })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'review-uuid' })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'APPROVED' })
  rightsStatus!: string | null;

  @ApiProperty({ type: Boolean, example: false })
  rightsGeoBlockRequired!: boolean;

  @ApiProperty({ type: Boolean, example: false })
  rightsGeoBlockConfigured!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsGeoBlockConfiguredAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Notes' })
  rightsGeoBlockNotesRu?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-26T12:00:00.000Z' })
  rightsGeoBlockVerifiedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'user-uuid' })
  rightsGeoBlockVerifiedByUserId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-26T11:30:00.000Z' })
  rightsGeoBlockLastGeneratedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'a1b2c3d4...' })
  rightsContentHash?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'v1' })
  rightsContentHashAlgorithmVersion?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsContentHashCalculatedAt?: string | null;

  @ApiProperty({ type: Boolean, example: false })
  rightsRecheckRequired!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsStaleDetectedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'REVISION_STALE' })
  rightsStaleReasonCode?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Версия текста устарела' })
  rightsStaleReasonRu?: string | null;

  // Phase 15: license snapshot recorded at publish / book creation time
  @ApiPropertyOptional({ type: String, nullable: true, example: 'COVERED' })
  rightsLicenseCoverageStatus?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-28T12:00:00.000Z' })
  rightsLicenseCheckedAt?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  rightsLicenseIds?: string[] | null;

  // Phase 16: denormalised rights-claim block state
  @ApiPropertyOptional({ type: Boolean, example: false })
  rightsClaimBlockActive?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-28T12:00:00.000Z' })
  rightsClaimBlockAppliedAt?: string | null;
}

export class BookRightsDashboardMetricsDto {
  @ApiProperty({ type: Boolean, example: true })
  hasClearance!: boolean;

  @ApiProperty({ type: Boolean, example: true })
  canPublishCurrentVersion!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'ALLOW' })
  publicationGate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'APPROVED' })
  overallStatus!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'HIGH' })
  confidence!: string | null;

  @ApiProperty({ type: Number, example: 0 })
  blockedCountriesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  licenseRequiredCountriesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  pendingCountriesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  geoBlockRequiredCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  unresolvedBlockingActionsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  evidenceCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  componentsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  componentTerritoryAssessmentsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  blockedComponentTerritoryAssessmentsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  reviewRequiredComponentTerritoryAssessmentsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  expiringComponentTerritoryAssessmentsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  reviewsCount!: number;

  @ApiProperty({ type: Boolean, example: false })
  isStale!: boolean;

  @ApiProperty({ type: Boolean, example: false })
  recheckRequired!: boolean;

  @ApiProperty({ type: Number, example: 0 })
  contributorsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  authorsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  translatorsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  narratorsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  contributorsWithoutPersonCount!: number;

  @ApiProperty({ type: Number, example: 7 })
  regionCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  blockedRegionCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  licenseRequiredRegionCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  pendingReviewRegionCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  mixedRegionCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  notTargetedRegionCount!: number;

  // Phase 15: license metrics
  @ApiProperty({ type: Number, example: 1 })
  licensesCount!: number;

  @ApiProperty({ type: Number, example: 1 })
  activeLicensesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  expiredLicensesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  revokedLicensesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  expiringSoonLicensesCount!: number;

  @ApiProperty({ type: Number, example: 1 })
  attributionRequiredLicensesCount!: number;

  @ApiProperty({ type: String, example: 'COVERED' })
  licenseCoverageStatus!: string;

  @ApiProperty({ type: Number, example: 3 })
  licenseCoveredCountriesCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  licenseUncoveredCountriesCount!: number;

  // Phase 16: rights claims / DMCA
  @ApiProperty({ type: Number, example: 0 })
  claimsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  activeClaimsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  blockingClaimsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  criticalClaimsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  overdueClaimsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  activeClaimBlocksCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  claimBlockedCountriesCount!: number;

  @ApiProperty({ type: Boolean, example: false })
  hasWorldwideClaimBlock!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'HIGH' })
  worstClaimSeverity!: string | null;

  // Phase 18: automatic recheck
  @ApiProperty({ type: Number, example: 0 })
  openRecheckTasksCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  overdueRecheckTasksCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  blockingRecheckTasksCount!: number;

  @ApiProperty({ type: String, nullable: true, example: '2027-07-30T00:00:00.000Z' })
  nextRecheckDueAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-30T06:00:00.000Z' })
  lastRecheckScanAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'INHERIT_REPORT' })
  recheckPolicy!: string | null;

  // Phase 19: lawyer workflow
  @ApiProperty({ type: String, nullable: true, example: 'HIGH' })
  riskLevel!: string | null;

  @ApiProperty({ type: Boolean, example: false })
  lawyerReviewRequired!: boolean;

  @ApiProperty({ type: Boolean, example: false })
  lawyerApproved!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-31T00:00:00.000Z' })
  lawyerApprovedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Иванова А. С.' })
  lawyerApprovedLawyerName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2028-07-31T00:00:00.000Z' })
  lawyerOpinionValidUntil!: string | null;

  @ApiProperty({ type: Number, example: 0 })
  openLawyerReviewsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  pendingLawyerConditionsCount!: number;

  @ApiProperty({ type: Number, example: 0 })
  lawyerReviewsCount!: number;

  // WP-1.2а: geo-block is mandatory for this version, but the country source looks broken.
  @ApiProperty({ type: Boolean, example: false })
  geoCountrySourceWarning!: boolean;
}

export class BookRightsDashboardDto {
  @ApiProperty({ type: BookRightsDashboardBookSummaryDto })
  book!: BookRightsDashboardBookSummaryDto;

  @ApiProperty({ type: BookRightsDashboardVersionSummaryDto })
  currentVersion!: BookRightsDashboardVersionSummaryDto;

  @ApiProperty({ type: [BookRightsDashboardVersionSummaryDto] })
  versions!: BookRightsDashboardVersionSummaryDto[];

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  intake!: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  currentProfile!: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  approvedReview!: Record<string, unknown> | null;

  @ApiProperty({ type: Array })
  reviewHistory!: Record<string, unknown>[];

  @ApiProperty({ type: Array })
  approvalHistory!: Record<string, unknown>[];

  @ApiProperty({ type: PublicationGateResultDto, nullable: true })
  publicationGate!: PublicationGateResultDto | null;

  @ApiProperty({ type: RightsContentHashCheckDto, nullable: true })
  contentHash!: RightsContentHashCheckDto | null;

  @ApiProperty({
    type: [RightsClaimSummaryDto],
    description: 'Phase 16: up to 50 most recent claims for this version and its book',
  })
  claims!: RightsClaimSummaryDto[];

  @ApiProperty({
    type: [RecheckTaskDto],
    description: 'Phase 18: up to 50 recheck tasks of this version and its rights profile',
  })
  recheckTasks!: RecheckTaskDto[];

  @ApiProperty({ type: RecheckScheduleDto, nullable: true })
  recheckSchedule!: RecheckScheduleDto | null;

  @ApiProperty({
    type: [LawyerReviewDto],
    description: 'Phase 19: up to 50 legal reviews of the rights profile of this version',
  })
  lawyerReviews!: LawyerReviewDto[];

  @ApiProperty({ type: [LawyerConditionDto] })
  pendingLawyerConditions!: LawyerConditionDto[];

  @ApiProperty({
    type: GeoCountrySourceHealthDto,
    nullable: true,
    description:
      'WP-1.2а: health of the GeoIP country source Phase 12 depends on. Counters are per process',
  })
  geoCountrySource!: GeoCountrySourceHealthDto | null;

  @ApiProperty({ type: BookRightsDashboardMetricsDto })
  summary!: BookRightsDashboardMetricsDto;
}
