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

  @ApiPropertyOptional({ type: String, nullable: true })
  deadlineAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  resolvedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  closedAt!: string | null;

  @ApiProperty({ type: String })
  claimantName!: string;

  @ApiProperty({ enum: RightsClaimantType })
  claimantType!: RightsClaimantType;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimantOrganization!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimantEmail!: string | null;

  @ApiProperty({ type: Boolean })
  claimantIsAuthorized!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  bookId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  bookVersionId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  rightsIntakeId!: string | null;

  @ApiProperty({ type: [String] })
  affectedCountryCodes!: string[];

  @ApiProperty({ type: [String] })
  affectedLanguages!: string[];

  @ApiPropertyOptional({ type: String, nullable: true })
  claimedWorkTitle!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimedWorkAuthor!: string | null;

  @ApiProperty({ type: String })
  descriptionRu!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  assignedToUserId!: string | null;

  @ApiProperty({ type: Boolean })
  blocksPublication!: boolean;

  @ApiProperty({ type: Boolean })
  requiresLawyerReview!: boolean;

  @ApiPropertyOptional({ enum: RightsClaimResolution, nullable: true })
  resolution!: RightsClaimResolution | null;

  // --- Computed fields (never persisted) ---

  @ApiProperty({ type: Boolean, description: 'The claim status belongs to OPEN_CLAIM_STATUSES' })
  isOpen!: boolean;

  @ApiProperty({ type: Boolean, description: 'Open claim whose deadline has already passed' })
  isOverdue!: boolean;

  @ApiPropertyOptional({
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

  @ApiPropertyOptional({ type: String, nullable: true })
  rightsComponentId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  componentType!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  titleRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimAccessBlockDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  rightsClaimId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  bookId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ enum: ClaimBlockScope })
  scope!: ClaimBlockScope;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'null = worldwide' })
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

  @ApiPropertyOptional({ type: String, nullable: true })
  appliedByUserId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  expiresAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  liftedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  liftedByUserId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
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

  @ApiPropertyOptional({ type: String, nullable: true })
  fileName!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  mediaAssetId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  storageKey!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  url!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  sha256!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  contentType!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  sizeBytes!: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  uploadedByUserId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimEventDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: RightsClaimEventType })
  eventType!: RightsClaimEventType;

  @ApiPropertyOptional({ enum: RightsClaimStatus, nullable: true })
  previousStatus!: RightsClaimStatus | null;

  @ApiPropertyOptional({ enum: RightsClaimStatus, nullable: true })
  currentStatus!: RightsClaimStatus | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  createdByUserId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;
}

export class RightsClaimDetailDto extends RightsClaimSummaryDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  claimantPhone!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimantAddress!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimantPersonId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  mediaAssetId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  claimedRightsDescriptionRu!: string | null;

  @ApiProperty({ type: [String] })
  infringingUrls!: string[];

  @ApiProperty({ type: Boolean })
  goodFaithStatement!: boolean;

  @ApiProperty({ type: Boolean })
  swornStatement!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  originalNoticeText!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  originalNoticeUrl!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  internalNotesRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  blocksPublicationOverrideReasonRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  responseSentAt!: string | null;

  @ApiPropertyOptional({ enum: RightsClaimChannel, nullable: true })
  responseChannel!: RightsClaimChannel | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  responseTextRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  responseByUserId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  counterNoticeReceivedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  counterNoticeClaimantName!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  counterNoticeTextRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  resolutionNotesRu!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  resolvedByUserId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentClaimId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
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

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  limit!: number;
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
  @ApiProperty({ type: Boolean, example: true })
  success!: boolean;
}
