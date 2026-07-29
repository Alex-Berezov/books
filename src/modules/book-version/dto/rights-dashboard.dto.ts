import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicationGateResultDto } from './publication-gate-result.dto';
import { RightsContentHashCheckDto } from '../../rights-intake/dto/rights-content-hash.dto';
import { RightsClaimSummaryDto } from '../../rights-claims/dto/rights-claim-response.dto';
import {
  RecheckScheduleDto,
  RecheckTaskDto,
} from '../../rights-recheck/dto/recheck-task-response.dto';

export class BookRightsDashboardBookSummaryDto {
  @ApiProperty({ example: 'a1111111-b222-4c33-d444-555555555555' })
  id!: string;

  @ApiProperty({ example: 'the-odyssey' })
  slug!: string;

  @ApiPropertyOptional({ nullable: true, example: 'intake-uuid' })
  rightsIntakeId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'profile-uuid' })
  currentRightsProfileId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'review-uuid' })
  approvedRightsReviewId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-25T12:00:00.000Z' })
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

  @ApiPropertyOptional({ nullable: true, example: 'profile-uuid' })
  rightsProfileId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'review-uuid' })
  approvedRightsReviewId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'APPROVED' })
  rightsStatus!: string | null;

  @ApiProperty({ example: false })
  rightsGeoBlockRequired!: boolean;

  @ApiProperty({ example: false })
  rightsGeoBlockConfigured!: boolean;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsGeoBlockConfiguredAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Notes' })
  rightsGeoBlockNotesRu?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-26T12:00:00.000Z' })
  rightsGeoBlockVerifiedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'user-uuid' })
  rightsGeoBlockVerifiedByUserId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-26T11:30:00.000Z' })
  rightsGeoBlockLastGeneratedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'a1b2c3d4...' })
  rightsContentHash?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'v1' })
  rightsContentHashAlgorithmVersion?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsContentHashCalculatedAt?: string | null;

  @ApiProperty({ example: false })
  rightsRecheckRequired!: boolean;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-25T12:00:00.000Z' })
  rightsStaleDetectedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'REVISION_STALE' })
  rightsStaleReasonCode?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Версия текста устарела' })
  rightsStaleReasonRu?: string | null;

  // Phase 15: license snapshot recorded at publish / book creation time
  @ApiPropertyOptional({ nullable: true, example: 'COVERED' })
  rightsLicenseCoverageStatus?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-28T12:00:00.000Z' })
  rightsLicenseCheckedAt?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  rightsLicenseIds?: string[] | null;

  // Phase 16: denormalised rights-claim block state
  @ApiPropertyOptional({ example: false })
  rightsClaimBlockActive?: boolean;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-28T12:00:00.000Z' })
  rightsClaimBlockAppliedAt?: string | null;
}

export class BookRightsDashboardMetricsDto {
  @ApiProperty({ example: true })
  hasClearance!: boolean;

  @ApiProperty({ example: true })
  canPublishCurrentVersion!: boolean;

  @ApiPropertyOptional({ nullable: true, example: 'ALLOW' })
  publicationGate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'APPROVED' })
  overallStatus!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'HIGH' })
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
  @ApiPropertyOptional({ example: 1 })
  licensesCount?: number;

  @ApiPropertyOptional({ example: 1 })
  activeLicensesCount?: number;

  @ApiPropertyOptional({ example: 0 })
  expiredLicensesCount?: number;

  @ApiPropertyOptional({ example: 0 })
  revokedLicensesCount?: number;

  @ApiPropertyOptional({ example: 0 })
  expiringSoonLicensesCount?: number;

  @ApiPropertyOptional({ example: 1 })
  attributionRequiredLicensesCount?: number;

  @ApiPropertyOptional({ example: 'COVERED' })
  licenseCoverageStatus?: string;

  @ApiPropertyOptional({ example: 3 })
  licenseCoveredCountriesCount?: number;

  @ApiPropertyOptional({ example: 0 })
  licenseUncoveredCountriesCount?: number;

  // Phase 16: rights claims / DMCA
  @ApiPropertyOptional({ example: 0 })
  claimsCount?: number;

  @ApiPropertyOptional({ example: 0 })
  activeClaimsCount?: number;

  @ApiPropertyOptional({ example: 0 })
  blockingClaimsCount?: number;

  @ApiPropertyOptional({ example: 0 })
  criticalClaimsCount?: number;

  @ApiPropertyOptional({ example: 0 })
  overdueClaimsCount?: number;

  @ApiPropertyOptional({ example: 0 })
  activeClaimBlocksCount?: number;

  @ApiPropertyOptional({ example: 0 })
  claimBlockedCountriesCount?: number;

  @ApiPropertyOptional({ example: false })
  hasWorldwideClaimBlock?: boolean;

  @ApiPropertyOptional({ nullable: true, example: 'HIGH' })
  worstClaimSeverity?: string | null;

  // Phase 18: automatic recheck
  @ApiPropertyOptional({ example: 0 })
  openRecheckTasksCount?: number;

  @ApiPropertyOptional({ example: 0 })
  overdueRecheckTasksCount?: number;

  @ApiPropertyOptional({ example: 0 })
  blockingRecheckTasksCount?: number;

  @ApiPropertyOptional({ nullable: true, example: '2027-07-30T00:00:00.000Z' })
  nextRecheckDueAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-30T06:00:00.000Z' })
  lastRecheckScanAt?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'INHERIT_REPORT' })
  recheckPolicy?: string | null;
}

export class BookRightsDashboardDto {
  @ApiProperty({ type: BookRightsDashboardBookSummaryDto })
  book!: BookRightsDashboardBookSummaryDto;

  @ApiProperty({ type: BookRightsDashboardVersionSummaryDto })
  currentVersion!: BookRightsDashboardVersionSummaryDto;

  @ApiProperty({ type: [BookRightsDashboardVersionSummaryDto] })
  versions!: BookRightsDashboardVersionSummaryDto[];

  @ApiPropertyOptional({ nullable: true })
  intake!: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  currentProfile!: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  approvedReview!: Record<string, unknown> | null;

  @ApiProperty({ type: Array })
  reviewHistory!: Record<string, unknown>[];

  @ApiProperty({ type: Array })
  approvalHistory!: Record<string, unknown>[];

  @ApiPropertyOptional({ type: PublicationGateResultDto, nullable: true })
  publicationGate!: PublicationGateResultDto | null;

  @ApiPropertyOptional({ type: RightsContentHashCheckDto, nullable: true })
  contentHash!: RightsContentHashCheckDto | null;

  @ApiPropertyOptional({
    type: [RightsClaimSummaryDto],
    description: 'Phase 16: up to 50 most recent claims for this version and its book',
  })
  claims?: RightsClaimSummaryDto[];

  @ApiPropertyOptional({
    type: [RecheckTaskDto],
    description: 'Phase 18: up to 50 recheck tasks of this version and its rights profile',
  })
  recheckTasks?: RecheckTaskDto[];

  @ApiPropertyOptional({ type: RecheckScheduleDto, nullable: true })
  recheckSchedule?: RecheckScheduleDto | null;

  @ApiProperty({ type: BookRightsDashboardMetricsDto })
  summary!: BookRightsDashboardMetricsDto;
}
