/**
 * Phase 17 models are reached through explicitly typed dynamic delegates: the generated
 * Prisma client is never regenerated in this repository, so it does not know about
 * RightsAgentUploadToken / RightsAgentSubmission / RightsNotification. Same pattern as
 * `rights-claims/rights-claim-interface.ts`.
 */

export enum RightsAgentTokenStatus {
  ACTIVE = 'ACTIVE',
  USED = 'USED',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
}

export enum RightsAgentSubmissionStatus {
  RECEIVED = 'RECEIVED',
  VALIDATED = 'VALIDATED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export enum RightsAgentSubmissionMaterialization {
  NOT_ATTEMPTED = 'NOT_ATTEMPTED',
  SKIPPED = 'SKIPPED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export enum RightsNotificationType {
  AGENT_REPORT_RECEIVED = 'AGENT_REPORT_RECEIVED',
  AGENT_REPORT_VALIDATION_FAILED = 'AGENT_REPORT_VALIDATION_FAILED',
  AGENT_REPORT_MATERIALIZED = 'AGENT_REPORT_MATERIALIZED',
  AGENT_REPORT_MATERIALIZATION_FAILED = 'AGENT_REPORT_MATERIALIZATION_FAILED',
  AGENT_TOKEN_ISSUED = 'AGENT_TOKEN_ISSUED',
  AGENT_TOKEN_REVOKED = 'AGENT_TOKEN_REVOKED',
  HUMAN_REVIEW_REQUIRED = 'HUMAN_REVIEW_REQUIRED',
  /** Phase 18: a recheck deadline is approaching or has arrived. */
  RECHECK_DUE = 'RECHECK_DUE',
  /** Phase 18: the recheck deadline has passed. */
  RECHECK_OVERDUE = 'RECHECK_OVERDUE',
  /** Phase 18: a recheck task was opened. */
  RECHECK_TASK_OPENED = 'RECHECK_TASK_OPENED',
  /** Phase 18: a recheck task was closed. */
  RECHECK_COMPLETED = 'RECHECK_COMPLETED',
  /** Phase 18: a legal change was applied across the catalogue. */
  LEGAL_CHANGE_APPLIED = 'LEGAL_CHANGE_APPLIED',
  /** Bridge to Phase 19 (lawyer workflow). Never created in Phase 17. */
  LAWYER_REVIEW_REQUIRED = 'LAWYER_REVIEW_REQUIRED',
  OTHER = 'OTHER',
}

export enum RightsNotificationSeverity {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
}

/** Row shape of the RightsAgentUploadToken table. */
export interface RightsAgentUploadTokenRecord {
  id: string;
  rightsIntakeId: string;
  tokenHash: string;
  tokenPrefix: string;
  status: RightsAgentTokenStatus;
  labelRu: string | null;
  allowedSchemaVersions: unknown;
  maxUses: number;
  usedCount: number;
  failedAttempts: number;
  maxFailedAttempts: number;
  allowRetryOnValidationError: boolean;
  autoMaterialize: boolean;
  expiresAt: Date;
  issuedByUserId: string | null;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  lastUsedUserAgent: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokeReasonRu: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Row shape of the RightsAgentSubmission table. */
export interface RightsAgentSubmissionRecord {
  id: string;
  rightsIntakeId: string;
  uploadTokenId: string | null;
  status: RightsAgentSubmissionStatus;
  declaredSchemaVersion: string | null;
  reportJsonSha256: string | null;
  payloadSizeBytes: number | null;
  sourceFileName: string | null;
  agentName: string | null;
  agentVersion: string | null;
  submittedIp: string | null;
  submittedUserAgent: string | null;
  rightsReviewImportId: string | null;
  validationErrorCount: number;
  validationWarningCount: number;
  rejectionCode: string | null;
  rejectionMessageRu: string | null;
  materialization: RightsAgentSubmissionMaterialization;
  materializationError: string | null;
  materializedProfileId: string | null;
  processedAt: Date | null;
  createdAt: Date;
  uploadToken?: { tokenPrefix: string } | null;
}

/** Row shape of the RightsNotification table. */
export interface RightsNotificationRecord {
  id: string;
  type: RightsNotificationType;
  severity: RightsNotificationSeverity;
  titleRu: string;
  messageRu: string;
  targetUserId: string | null;
  rightsIntakeId: string | null;
  agentSubmissionId: string | null;
  rightsReviewImportId: string | null;
  rightsProfileId: string | null;
  bookVersionId: string | null;
  payload: unknown;
  isRead: boolean;
  readAt: Date | null;
  readByUserId: string | null;
  createdAt: Date;
}

export interface RightsAgentUploadTokenDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsAgentUploadTokenRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsAgentUploadTokenRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsAgentUploadTokenRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsAgentUploadTokenRecord>;
  update(args: Record<string, unknown>): Promise<RightsAgentUploadTokenRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsAgentSubmissionDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsAgentSubmissionRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsAgentSubmissionRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsAgentSubmissionRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsAgentSubmissionRecord>;
  update(args: Record<string, unknown>): Promise<RightsAgentSubmissionRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsNotificationDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsNotificationRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsNotificationRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsNotificationRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsNotificationRecord>;
  update(args: Record<string, unknown>): Promise<RightsNotificationRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

/** Subset of the Prisma client the agent module relies on. */
export interface AgentDatabaseClient {
  rightsAgentUploadToken: RightsAgentUploadTokenDelegate;
  rightsAgentSubmission: RightsAgentSubmissionDelegate;
  rightsNotification: RightsNotificationDelegate;
  $transaction<T>(callback: (client: AgentDatabaseClient) => Promise<T>): Promise<T>;
}

/** Context the token guard attaches to the request after a token resolves. */
export interface AgentTokenRequestContext {
  tokenId: string;
  rightsIntakeId: string;
  allowedSchemaVersions: string[] | null;
  autoMaterialize: boolean;
  allowRetryOnValidationError: boolean;
}

/** Result of resolving a raw token for an incoming agent request. */
export type TokenResolution =
  | { ok: false; code: string }
  | { ok: true; token: RightsAgentUploadTokenRecord };

/** Narrow a Json column that should hold a list of strings. */
export const toStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
};
