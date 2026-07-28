export enum RightsClaimType {
  DMCA_TAKEDOWN = 'DMCA_TAKEDOWN',
  COPYRIGHT_INFRINGEMENT = 'COPYRIGHT_INFRINGEMENT',
  LICENSE_VIOLATION = 'LICENSE_VIOLATION',
  ATTRIBUTION_MISSING = 'ATTRIBUTION_MISSING',
  TERRITORY_VIOLATION = 'TERRITORY_VIOLATION',
  TRADEMARK = 'TRADEMARK',
  PRIVACY_PERSONAL_DATA = 'PRIVACY_PERSONAL_DATA',
  DEFAMATION = 'DEFAMATION',
  COUNTER_NOTICE = 'COUNTER_NOTICE',
  OTHER = 'OTHER',
}

export enum RightsClaimStatus {
  RECEIVED = 'RECEIVED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  ACTION_REQUIRED = 'ACTION_REQUIRED',
  AWAITING_CLAIMANT = 'AWAITING_CLAIMANT',
  CONTENT_REMOVED = 'CONTENT_REMOVED',
  CONTENT_RESTRICTED = 'CONTENT_RESTRICTED',
  COUNTER_NOTICE_FILED = 'COUNTER_NOTICE_FILED',
  ESCALATED_TO_LAWYER = 'ESCALATED_TO_LAWYER',
  RESOLVED_VALID = 'RESOLVED_VALID',
  RESOLVED_INVALID = 'RESOLVED_INVALID',
  WITHDRAWN = 'WITHDRAWN',
  CLOSED = 'CLOSED',
}

export enum RightsClaimSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum RightsClaimChannel {
  EMAIL = 'EMAIL',
  WEB_FORM = 'WEB_FORM',
  POSTAL = 'POSTAL',
  PHONE = 'PHONE',
  LEGAL_COUNSEL = 'LEGAL_COUNSEL',
  PLATFORM_NOTICE = 'PLATFORM_NOTICE',
  OTHER = 'OTHER',
}

export enum RightsClaimantType {
  RIGHTS_HOLDER = 'RIGHTS_HOLDER',
  AUTHOR = 'AUTHOR',
  PUBLISHER = 'PUBLISHER',
  AGENT = 'AGENT',
  LAW_FIRM = 'LAW_FIRM',
  COLLECTING_SOCIETY = 'COLLECTING_SOCIETY',
  PLATFORM = 'PLATFORM',
  INDIVIDUAL = 'INDIVIDUAL',
  UNKNOWN = 'UNKNOWN',
}

export enum RightsClaimResolution {
  VALID_CONTENT_REMOVED = 'VALID_CONTENT_REMOVED',
  VALID_LICENSE_OBTAINED = 'VALID_LICENSE_OBTAINED',
  VALID_GEO_RESTRICTED = 'VALID_GEO_RESTRICTED',
  VALID_ATTRIBUTION_ADDED = 'VALID_ATTRIBUTION_ADDED',
  INVALID_REJECTED = 'INVALID_REJECTED',
  WITHDRAWN_BY_CLAIMANT = 'WITHDRAWN_BY_CLAIMANT',
  COUNTER_NOTICE_UPHELD = 'COUNTER_NOTICE_UPHELD',
  NO_ACTION_NEEDED = 'NO_ACTION_NEEDED',
  OTHER = 'OTHER',
}

export enum RightsClaimBlockStatus {
  ACTIVE = 'ACTIVE',
  LIFTED = 'LIFTED',
  EXPIRED = 'EXPIRED',
}

export enum RightsClaimAttachmentType {
  CLAIM_NOTICE = 'CLAIM_NOTICE',
  EVIDENCE = 'EVIDENCE',
  POWER_OF_ATTORNEY = 'POWER_OF_ATTORNEY',
  LICENSE_DOCUMENT = 'LICENSE_DOCUMENT',
  CORRESPONDENCE = 'CORRESPONDENCE',
  COUNTER_NOTICE = 'COUNTER_NOTICE',
  RESPONSE_LETTER = 'RESPONSE_LETTER',
  LEGAL_OPINION = 'LEGAL_OPINION',
  SCREENSHOT = 'SCREENSHOT',
  OTHER = 'OTHER',
}

export enum RightsClaimEventType {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  ASSIGNED = 'ASSIGNED',
  BLOCK_APPLIED = 'BLOCK_APPLIED',
  BLOCK_LIFTED = 'BLOCK_LIFTED',
  BLOCK_EXPIRED = 'BLOCK_EXPIRED',
  RESPONSE_RECORDED = 'RESPONSE_RECORDED',
  COUNTER_NOTICE_RECORDED = 'COUNTER_NOTICE_RECORDED',
  RESOLVED = 'RESOLVED',
  REOPENED = 'REOPENED',
  ESCALATED = 'ESCALATED',
  DEADLINE_CHANGED = 'DEADLINE_CHANGED',
  COMPONENT_LINKED = 'COMPONENT_LINKED',
  COMPONENT_UNLINKED = 'COMPONENT_UNLINKED',
  ATTACHMENT_ADDED = 'ATTACHMENT_ADDED',
  ATTACHMENT_REMOVED = 'ATTACHMENT_REMOVED',
  VERSION_UNPUBLISHED = 'VERSION_UNPUBLISHED',
}

/**
 * Access-block scopes reuse the Phase 12 `GeoBlockScope` enum. Declared locally because
 * the generated Prisma client is not regenerated in this repository.
 */
export enum ClaimBlockScope {
  ENTIRE_BOOK = 'ENTIRE_BOOK',
  LANGUAGE_EDITION = 'LANGUAGE_EDITION',
  TEXT_READER = 'TEXT_READER',
  DOWNLOADS = 'DOWNLOADS',
  AUDIO = 'AUDIO',
  SPECIFIC_ASSET = 'SPECIFIC_ASSET',
}

/** Row shape of the RightsClaim table as returned by the Prisma delegate. */
export interface RightsClaimRecord {
  id: string;
  claimNumber: string;
  claimType: RightsClaimType;
  status: RightsClaimStatus;
  severity: RightsClaimSeverity;
  channel: RightsClaimChannel;
  receivedAt: Date;
  deadlineAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  claimantName: string;
  claimantType: RightsClaimantType;
  claimantOrganization: string | null;
  claimantEmail: string | null;
  claimantPhone: string | null;
  claimantAddress: string | null;
  claimantIsAuthorized: boolean;
  claimantPersonId: string | null;
  bookId: string | null;
  bookVersionId: string | null;
  rightsProfileId: string | null;
  rightsIntakeId: string | null;
  mediaAssetId: string | null;
  affectedCountryCodes: unknown;
  affectedLanguages: unknown;
  claimedWorkTitle: string | null;
  claimedWorkAuthor: string | null;
  claimedRightsDescriptionRu: string | null;
  descriptionRu: string;
  infringingUrls: unknown;
  goodFaithStatement: boolean;
  swornStatement: boolean;
  originalNoticeText: string | null;
  originalNoticeUrl: string | null;
  assignedToUserId: string | null;
  internalNotesRu: string | null;
  blocksPublication: boolean;
  blocksPublicationOverrideReasonRu: string | null;
  requiresLawyerReview: boolean;
  responseSentAt: Date | null;
  responseChannel: RightsClaimChannel | null;
  responseTextRu: string | null;
  responseByUserId: string | null;
  counterNoticeReceivedAt: Date | null;
  counterNoticeClaimantName: string | null;
  counterNoticeTextRu: string | null;
  resolution: RightsClaimResolution | null;
  resolutionNotesRu: string | null;
  resolvedByUserId: string | null;
  parentClaimId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  components?: RightsClaimComponentRecord[];
  accessBlocks?: RightsClaimAccessBlockRecord[];
  attachments?: RightsClaimAttachmentRecord[];
  events?: RightsClaimEventRecord[];
}

export interface RightsClaimComponentRecord {
  id: string;
  rightsClaimId: string;
  rightsComponentId: string | null;
  componentType: string | null;
  titleRu: string | null;
  notesRu: string | null;
  createdAt: Date;
}

export interface RightsClaimAccessBlockRecord {
  id: string;
  rightsClaimId: string;
  bookId: string | null;
  bookVersionId: string | null;
  scope: ClaimBlockScope;
  countryCode: string | null;
  status: RightsClaimBlockStatus;
  reasonRu: string;
  appliedAt: Date;
  appliedByUserId: string | null;
  expiresAt: Date | null;
  liftedAt: Date | null;
  liftedByUserId: string | null;
  liftReasonRu: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RightsClaimAttachmentRecord {
  id: string;
  rightsClaimId: string;
  attachmentType: RightsClaimAttachmentType;
  title: string;
  fileName: string | null;
  mediaAssetId: string | null;
  storageKey: string | null;
  url: string | null;
  sha256: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  notesRu: string | null;
  uploadedByUserId: string | null;
  isDeleted: boolean;
  removedAt: Date | null;
  removedByUserId: string | null;
  createdAt: Date;
}

export interface RightsClaimEventRecord {
  id: string;
  rightsClaimId: string;
  eventType: RightsClaimEventType;
  previousStatus: RightsClaimStatus | null;
  currentStatus: RightsClaimStatus | null;
  notesRu: string | null;
  payload: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

/**
 * Minimal delegate surface used by the claims module. The repository does not run
 * `prisma generate` locally, so the new models are reached through dynamic delegates
 * that are typed explicitly here instead of using `any`.
 */
export interface RightsClaimDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsClaimRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsClaimRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsClaimRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsClaimRecord>;
  update(args: Record<string, unknown>): Promise<RightsClaimRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsClaimComponentDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsClaimComponentRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsClaimComponentRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsClaimComponentRecord>;
  delete(args: Record<string, unknown>): Promise<RightsClaimComponentRecord>;
}

export interface RightsClaimAccessBlockDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsClaimAccessBlockRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsClaimAccessBlockRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsClaimAccessBlockRecord>;
  update(args: Record<string, unknown>): Promise<RightsClaimAccessBlockRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsClaimAttachmentDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsClaimAttachmentRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsClaimAttachmentRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsClaimAttachmentRecord>;
  update(args: Record<string, unknown>): Promise<RightsClaimAttachmentRecord>;
}

export interface RightsClaimEventDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsClaimEventRecord[]>;
  create(args: Record<string, unknown>): Promise<RightsClaimEventRecord>;
}

/** The `BookVersion` columns the claims module reads/writes through dynamic access. */
export interface ClaimBookVersionRecord {
  id: string;
  bookId: string;
  status: string;
  rightsClaimBlockActive?: boolean;
  rightsClaimBlockAppliedAt?: Date | null;
}

export interface ClaimBookVersionDelegate {
  findMany(args?: Record<string, unknown>): Promise<ClaimBookVersionRecord[]>;
  findUnique(args: Record<string, unknown>): Promise<ClaimBookVersionRecord | null>;
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export { toStringArray } from '../rights-licenses/rights-license-interface';
