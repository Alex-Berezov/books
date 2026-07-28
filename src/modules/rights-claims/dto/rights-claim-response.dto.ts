import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClaimBlockScope,
  RightsClaimAttachmentType,
  RightsClaimBlockStatus,
  RightsClaimChannel,
  RightsClaimEventType,
  RightsClaimResolution,
  RightsClaimSeverity,
  RightsClaimStatus,
  RightsClaimType,
  RightsClaimantType,
} from '../rights-claim-interface';

export class RightsClaimSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'CLM-2026-000042' })
  claimNumber!: string;

  @ApiProperty({ enum: RightsClaimType })
  claimType!: RightsClaimType;

  @ApiProperty({ enum: RightsClaimStatus })
  status!: RightsClaimStatus;

  @ApiProperty({ enum: RightsClaimSeverity })
  severity!: RightsClaimSeverity;

  @ApiProperty({ enum: RightsClaimChannel })
  channel!: RightsClaimChannel;

  @ApiProperty()
  receivedAt!: string;

  @ApiPropertyOptional({ nullable: true })
  deadlineAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  resolvedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  closedAt!: string | null;

  @ApiProperty()
  claimantName!: string;

  @ApiProperty({ enum: RightsClaimantType })
  claimantType!: RightsClaimantType;

  @ApiPropertyOptional({ nullable: true })
  claimantOrganization!: string | null;

  @ApiPropertyOptional({ nullable: true })
  claimantEmail!: string | null;

  @ApiProperty()
  claimantIsAuthorized!: boolean;

  @ApiPropertyOptional({ nullable: true })
  bookId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  bookVersionId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rightsProfileId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: [String] })
  affectedCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  affectedLanguages!: string[];

  @ApiPropertyOptional({ nullable: true })
  claimedWorkTitle!: string | null;

  @ApiPropertyOptional({ nullable: true })
  claimedWorkAuthor!: string | null;

  @ApiProperty()
  descriptionRu!: string;

  @ApiPropertyOptional({ nullable: true })
  assignedToUserId!: string | null;

  @ApiProperty()
  blocksPublication!: boolean;

  @ApiProperty()
  requiresLawyerReview!: boolean;

  @ApiPropertyOptional({ enum: RightsClaimResolution, nullable: true })
  resolution!: RightsClaimResolution | null;

  // --- Computed fields (never persisted) ---

  @ApiProperty({ description: 'The claim status belongs to OPEN_CLAIM_STATUSES' })
  isOpen!: boolean;

  @ApiProperty({ description: 'Open claim whose deadline has already passed' })
  isOverdue!: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'May be negative for overdue claims' })
  daysUntilDeadline!: number | null;

  @ApiProperty()
  activeBlocksCount!: number;

  @ApiProperty()
  hasWorldwideBlock!: boolean;

  @ApiProperty({ type: [String] })
  blockedCountryCodes!: string[];

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class RightsClaimComponentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rightsClaimId!: string;

  @ApiPropertyOptional({ nullable: true })
  rightsComponentId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  componentType!: string | null;

  @ApiPropertyOptional({ nullable: true })
  titleRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class RightsClaimAccessBlockDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rightsClaimId!: string;

  @ApiPropertyOptional({ nullable: true })
  bookId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ enum: ClaimBlockScope })
  scope!: ClaimBlockScope;

  @ApiPropertyOptional({ nullable: true, description: 'null = worldwide' })
  countryCode!: string | null;

  @ApiProperty({ enum: RightsClaimBlockStatus })
  status!: RightsClaimBlockStatus;

  @ApiProperty({
    enum: RightsClaimBlockStatus,
    description: 'Status computed at request time (expiry applied)',
  })
  effectiveStatus!: RightsClaimBlockStatus;

  @ApiProperty()
  reasonRu!: string;

  @ApiProperty()
  appliedAt!: string;

  @ApiPropertyOptional({ nullable: true })
  appliedByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  expiresAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  liftedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  liftedByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  liftReasonRu!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class RightsClaimAttachmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rightsClaimId!: string;

  @ApiProperty({ enum: RightsClaimAttachmentType })
  attachmentType!: RightsClaimAttachmentType;

  @ApiProperty()
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  fileName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  mediaAssetId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  storageKey!: string | null;

  @ApiPropertyOptional({ nullable: true })
  url!: string | null;

  @ApiPropertyOptional({ nullable: true })
  sha256!: string | null;

  @ApiPropertyOptional({ nullable: true })
  contentType!: string | null;

  @ApiPropertyOptional({ nullable: true })
  sizeBytes!: number | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  uploadedByUserId!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class RightsClaimEventDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: RightsClaimEventType })
  eventType!: RightsClaimEventType;

  @ApiPropertyOptional({ enum: RightsClaimStatus, nullable: true })
  previousStatus!: RightsClaimStatus | null;

  @ApiPropertyOptional({ enum: RightsClaimStatus, nullable: true })
  currentStatus!: RightsClaimStatus | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  createdByUserId!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class RightsClaimDetailDto extends RightsClaimSummaryDto {
  @ApiPropertyOptional({ nullable: true })
  claimantPhone!: string | null;

  @ApiPropertyOptional({ nullable: true })
  claimantAddress!: string | null;

  @ApiPropertyOptional({ nullable: true })
  claimantPersonId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  mediaAssetId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  claimedRightsDescriptionRu!: string | null;

  @ApiProperty({ type: [String] })
  infringingUrls!: string[];

  @ApiProperty()
  goodFaithStatement!: boolean;

  @ApiProperty()
  swornStatement!: boolean;

  @ApiPropertyOptional({ nullable: true })
  originalNoticeText!: string | null;

  @ApiPropertyOptional({ nullable: true })
  originalNoticeUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  internalNotesRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  blocksPublicationOverrideReasonRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  responseSentAt!: string | null;

  @ApiPropertyOptional({ enum: RightsClaimChannel, nullable: true })
  responseChannel!: RightsClaimChannel | null;

  @ApiPropertyOptional({ nullable: true })
  responseTextRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  responseByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  counterNoticeReceivedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  counterNoticeClaimantName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  counterNoticeTextRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  resolutionNotesRu!: string | null;

  @ApiPropertyOptional({ nullable: true })
  resolvedByUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  parentClaimId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  createdByUserId!: string | null;

  @ApiProperty({ type: [RightsClaimComponentDto] })
  components!: RightsClaimComponentDto[];

  @ApiProperty({ type: [RightsClaimAccessBlockDto] })
  accessBlocks!: RightsClaimAccessBlockDto[];

  @ApiProperty({ type: [RightsClaimAttachmentDto] })
  attachments!: RightsClaimAttachmentDto[];

  @ApiProperty({ type: [RightsClaimEventDto] })
  events!: RightsClaimEventDto[];
}

export class RightsClaimListResponseDto {
  @ApiProperty({ type: [RightsClaimSummaryDto] })
  items!: RightsClaimSummaryDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

export class ClaimIssueDto {
  @ApiProperty({ example: 'ACTIVE_RIGHTS_CLAIM' })
  code!: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity!: 'BLOCKER' | 'WARNING';

  @ApiProperty()
  messageRu!: string;

  @ApiPropertyOptional({ nullable: true })
  claimId?: string;

  @ApiPropertyOptional({ nullable: true })
  claimNumber?: string;

  @ApiPropertyOptional({ nullable: true })
  countryCode?: string;

  @ApiPropertyOptional({ description: 'Extra context for the admin UI' })
  details?: Record<string, unknown>;
}

export class ClaimGateEvaluationDto {
  @ApiProperty()
  activeClaimsCount!: number;

  @ApiProperty()
  blockingClaimsCount!: number;

  @ApiProperty()
  criticalClaimsCount!: number;

  @ApiProperty()
  overdueClaimsCount!: number;

  @ApiProperty()
  activeBlocksCount!: number;

  @ApiProperty()
  hasWorldwideBlock!: boolean;

  @ApiProperty({ type: [String] })
  claimBlockedCountryCodes!: string[];

  @ApiPropertyOptional({ enum: RightsClaimSeverity, nullable: true })
  worstSeverity!: RightsClaimSeverity | null;

  @ApiProperty({ type: [String] })
  claimIds!: string[];

  @ApiProperty({ type: [ClaimIssueDto] })
  blockers!: ClaimIssueDto[];

  @ApiProperty({ type: [ClaimIssueDto] })
  warnings!: ClaimIssueDto[];
}

export class ClaimMutationResultDto {
  @ApiProperty({ example: true })
  success!: boolean;
}
