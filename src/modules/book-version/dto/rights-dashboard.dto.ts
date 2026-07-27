import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicationGateResultDto } from './publication-gate-result.dto';
import { RightsContentHashCheckDto } from '../../rights-intake/dto/rights-content-hash.dto';

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

  @ApiProperty({ type: BookRightsDashboardMetricsDto })
  summary!: BookRightsDashboardMetricsDto;
}
