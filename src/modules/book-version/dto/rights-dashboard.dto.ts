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
  @ApiProperty({ example: 'a1111111-b222-4c33-d444-555555555555' })
  id!: string;

  @ApiProperty({ example: 'the-odyssey' })
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
  @ApiProperty({ example: 'v1111111-b222-4c33-d444-555555555555' })
  id!: string;

  @ApiProperty({ example: 'en' })
  language!: string;

  @ApiProperty({ example: 'text' })
  type!: string;

  @ApiProperty({ example: 'published' })
  status!: string;

  @ApiPropertyOptional({ example: 'The Odyssey' })
  title?: string;

  @ApiProperty({ type: String, nullable: true, example: 'profile-uuid' })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'review-uuid' })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'APPROVED' })
  rightsStatus!: string | null;

  @ApiProperty({ example: false })
  rightsGeoBlockRequired!: boolean;

  @ApiProperty({ example: false })
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

  @ApiProperty({ example: false })
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
  @ApiPropertyOptional({ example: false })
  rightsClaimBlockActive?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-07-28T12:00:00.000Z' })
  rightsClaimBlockAppliedAt?: string | null;
}

export class BookRightsDashboardMetricsDto {
  @ApiProperty({ example: true })
  hasClearance!: boolean;

  @ApiProperty({ example: true })
  canPublishCurrentVersion!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'ALLOW' })
  publicationGate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'APPROVED' })
  overallStatus!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'HIGH' })
  confidence!: string | null;

  @ApiProperty({ example: 0 })
  blockedCountriesCount!: number;

  @ApiProperty({ example: 0 })
  licenseRequiredCountriesCount!: number;

  @ApiProperty({ example: 0 })
  pendingCountriesCount!: number;

  @ApiProperty({ example: 0 })
  geoBlockRequiredCount!: number;

  @ApiProperty({ example: 0 })
  unresolvedBlockingActionsCount!: number;

  @ApiProperty({ example: 0 })
  evidenceCount!: number;

  @ApiProperty({ example: 0 })
  componentsCount!: number;

  @ApiProperty({ example: 0 })
  componentTerritoryAssessmentsCount!: number;

  @ApiProperty({ example: 0 })
  blockedComponentTerritoryAssessmentsCount!: number;

  @ApiProperty({ example: 0 })
  reviewRequiredComponentTerritoryAssessmentsCount!: number;

  @ApiProperty({ example: 0 })
  expiringComponentTerritoryAssessmentsCount!: number;

  @ApiProperty({ example: 0 })
  reviewsCount!: number;

  @ApiProperty({ example: false })
  isStale!: boolean;

  @ApiProperty({ example: false })
  recheckRequired!: boolean;

  @ApiProperty({ example: 0 })
  contributorsCount!: number;

  @ApiProperty({ example: 0 })
  authorsCount!: number;

  @ApiProperty({ example: 0 })
  translatorsCount!: number;

  @ApiProperty({ example: 0 })
  narratorsCount!: number;

  @ApiProperty({ example: 0 })
  contributorsWithoutPersonCount!: number;

  @ApiProperty({ example: 7 })
  regionCount!: number;

  @ApiProperty({ example: 0 })
  blockedRegionCount!: number;

  @ApiProperty({ example: 0 })
  licenseRequiredRegionCount!: number;

  @ApiProperty({ example: 0 })
  pendingReviewRegionCount!: number;

  @ApiProperty({ example: 0 })
  mixedRegionCount!: number;

  @ApiProperty({ example: 0 })
  notTargetedRegionCount!: number;

  // Phase 15: license metrics
  @ApiProperty({ example: 1 })
  licensesCount!: number;

  @ApiProperty({ example: 1 })
  activeLicensesCount!: number;

  @ApiProperty({ example: 0 })
  expiredLicensesCount!: number;

  @ApiProperty({ example: 0 })
  revokedLicensesCount!: number;

  @ApiProperty({ example: 0 })
  expiringSoonLicensesCount!: number;

  @ApiProperty({ example: 1 })
  attributionRequiredLicensesCount!: number;

  @ApiProperty({ example: 'COVERED' })
  licenseCoverageStatus!: string;

  @ApiProperty({ example: 3 })
  licenseCoveredCountriesCount!: number;

  @ApiProperty({ example: 0 })
  licenseUncoveredCountriesCount!: number;

  // Phase 16: rights claims / DMCA
  @ApiProperty({ example: 0 })
  claimsCount!: number;

  @ApiProperty({ example: 0 })
  activeClaimsCount!: number;

  @ApiProperty({ example: 0 })
  blockingClaimsCount!: number;

  @ApiProperty({ example: 0 })
  criticalClaimsCount!: number;

  @ApiProperty({ example: 0 })
  overdueClaimsCount!: number;

  @ApiProperty({ example: 0 })
  activeClaimBlocksCount!: number;

  @ApiProperty({ example: 0 })
  claimBlockedCountriesCount!: number;

  @ApiProperty({ example: false })
  hasWorldwideClaimBlock!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'HIGH' })
  worstClaimSeverity!: string | null;

  // Phase 18: automatic recheck
  @ApiProperty({ example: 0 })
  openRecheckTasksCount!: number;

  @ApiProperty({ example: 0 })
  overdueRecheckTasksCount!: number;

  @ApiProperty({ example: 0 })
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

  @ApiProperty({ example: false })
  lawyerReviewRequired!: boolean;

  @ApiProperty({ example: false })
  lawyerApproved!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-31T00:00:00.000Z' })
  lawyerApprovedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Иванова А. С.' })
  lawyerApprovedLawyerName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2028-07-31T00:00:00.000Z' })
  lawyerOpinionValidUntil!: string | null;

  @ApiProperty({ example: 0 })
  openLawyerReviewsCount!: number;

  @ApiProperty({ example: 0 })
  pendingLawyerConditionsCount!: number;

  @ApiProperty({ example: 0 })
  lawyerReviewsCount!: number;

  // WP-1.2а: geo-block is mandatory for this version, but the country source looks broken.
  @ApiProperty({ example: false })
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
