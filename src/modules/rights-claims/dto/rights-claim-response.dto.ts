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
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'CLM-2026-000042' })
  claimNumber!: string;

  @ApiProperty({ enum: RightsClaimType })
  claimType!: RightsClaimType;

  @ApiProperty({ enum: RightsClaimStatus })
  status!: RightsClaimStatus;

  @ApiProperty({ enum: RightsClaimSeverity })
  severity!: RightsClaimSeverity;

  @ApiProperty({ enum: RightsClaimChannel })
  channel!: RightsClaimChannel;

  @ApiProperty({ type: String })
  receivedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  deadlineAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;

  @ApiProperty({ type: String })
  claimantName!: string;

  @ApiProperty({ enum: RightsClaimantType })
  claimantType!: RightsClaimantType;

  @ApiProperty({ type: String, nullable: true })
  claimantOrganization!: string | null;

  @ApiProperty({ type: String, nullable: true })
  claimantEmail!: string | null;

  @ApiProperty({ type: Boolean })
  claimantIsAuthorized!: boolean;

  @ApiProperty({ type: String, nullable: true })
  bookId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: [String] })
  affectedCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  affectedLanguages!: string[];

  @ApiProperty({ type: String, nullable: true })
  claimedWorkTitle!: string | null;

  @ApiProperty({ type: String, nullable: true })
  claimedWorkAuthor!: string | null;

  @ApiProperty({ type: String })
  descriptionRu!: string;

  @ApiProperty({ type: String, nullable: true })
  assignedToUserId!: string | null;

  @ApiProperty({ type: Boolean })
  blocksPublication!: boolean;

  @ApiProperty({ type: Boolean })
  requiresLawyerReview!: boolean;

  @ApiProperty({ enum: RightsClaimResolution, nullable: true })
  resolution!: RightsClaimResolution | null;

  // --- Computed fields (never persisted) ---

  @ApiProperty({ type: Boolean, description: 'The claim status belongs to OPEN_CLAIM_STATUSES' })
  isOpen!: boolean;

  @ApiProperty({ type: Boolean, description: 'Open claim whose deadline has already passed' })
  isOverdue!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'May be negative for overdue claims',
  })
  daysUntilDeadline!: number | null;

  @ApiProperty({ type: Number })
  activeBlocksCount!: number;

  @ApiProperty({ type: Boolean })
  hasWorldwideBlock!: boolean;

  @ApiProperty({ type: [String] })
  blockedCountryCodes!: string[];

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String })
  updatedAt!: string;
}

export class RightsClaimComponentDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  rightsClaimId!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsComponentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  componentType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  titleRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimAccessBlockDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  rightsClaimId!: string;

  @ApiProperty({ type: String, nullable: true })
  bookId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ enum: ClaimBlockScope })
  scope!: ClaimBlockScope;

  @ApiProperty({ type: String, nullable: true, description: 'null = worldwide' })
  countryCode!: string | null;

  @ApiProperty({ enum: RightsClaimBlockStatus })
  status!: RightsClaimBlockStatus;

  @ApiProperty({
    enum: RightsClaimBlockStatus,
    description: 'Status computed at request time (expiry applied)',
  })
  effectiveStatus!: RightsClaimBlockStatus;

  @ApiProperty({ type: String })
  reasonRu!: string;

  @ApiProperty({ type: String })
  appliedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  appliedByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  liftedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  liftedByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  liftReasonRu!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimAttachmentDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  rightsClaimId!: string;

  @ApiProperty({ enum: RightsClaimAttachmentType })
  attachmentType!: RightsClaimAttachmentType;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  fileName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  mediaAssetId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  storageKey!: string | null;

  @ApiProperty({ type: String, nullable: true })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true })
  sha256!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contentType!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  sizeBytes!: number | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  uploadedByUserId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimEventDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: RightsClaimEventType })
  eventType!: RightsClaimEventType;

  @ApiProperty({ enum: RightsClaimStatus, nullable: true })
  previousStatus!: RightsClaimStatus | null;

  @ApiProperty({ enum: RightsClaimStatus, nullable: true })
  currentStatus!: RightsClaimStatus | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdByUserId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimDetailDto extends RightsClaimSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  claimantPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  claimantAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  claimantPersonId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  mediaAssetId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  claimedRightsDescriptionRu!: string | null;

  @ApiProperty({ type: [String] })
  infringingUrls!: string[];

  @ApiProperty({ type: Boolean })
  goodFaithStatement!: boolean;

  @ApiProperty({ type: Boolean })
  swornStatement!: boolean;

  @ApiProperty({ type: String, nullable: true })
  originalNoticeText!: string | null;

  @ApiProperty({ type: String, nullable: true })
  originalNoticeUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  internalNotesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  blocksPublicationOverrideReasonRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  responseSentAt!: string | null;

  @ApiProperty({ enum: RightsClaimChannel, nullable: true })
  responseChannel!: RightsClaimChannel | null;

  @ApiProperty({ type: String, nullable: true })
  responseTextRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  responseByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  counterNoticeReceivedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  counterNoticeClaimantName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  counterNoticeTextRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolutionNotesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolvedByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  parentClaimId!: string | null;

  @ApiProperty({ type: String, nullable: true })
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

export class ClaimIssueDto {
  @ApiProperty({ type: String, example: 'ACTIVE_RIGHTS_CLAIM' })
  code!: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity!: 'BLOCKER' | 'WARNING';

  @ApiProperty({ type: String })
  messageRu!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimId?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimNumber?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  countryCode?: string;

  @ApiPropertyOptional({ description: 'Extra context for the admin UI' })
  details?: Record<string, unknown>;
}

export class ClaimGateEvaluationDto {
  @ApiProperty({ type: Number })
  activeClaimsCount!: number;

  @ApiProperty({ type: Number })
  blockingClaimsCount!: number;

  @ApiProperty({ type: Number })
  criticalClaimsCount!: number;

  @ApiProperty({ type: Number })
  overdueClaimsCount!: number;

  @ApiProperty({ type: Number })
  activeBlocksCount!: number;

  @ApiProperty({ type: Boolean })
  hasWorldwideBlock!: boolean;

  @ApiProperty({ type: [String] })
  claimBlockedCountryCodes!: string[];

  @ApiProperty({ enum: RightsClaimSeverity, nullable: true })
  worstSeverity!: RightsClaimSeverity | null;

  @ApiProperty({ type: [String] })
  claimIds!: string[];

  @ApiProperty({ type: [ClaimIssueDto] })
  blockers!: ClaimIssueDto[];

  @ApiProperty({ type: [ClaimIssueDto] })
  warnings!: ClaimIssueDto[];
}

export class ClaimMutationResultDto {
  @ApiProperty({ type: Boolean, example: true })
  success!: boolean;
}
