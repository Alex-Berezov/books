/**
 * Phase 18 models are reached through explicitly typed dynamic delegates: the generated
 * Prisma client is never regenerated in this repository, so it does not know about
 * RightsRecheckTask / RightsRecheckEvent / RightsLegalChangeEvent / RightsRecheckScanRun
 * nor about the new Phase 18 columns on RightsProfile and RightsReview.
 * Same pattern as `rights-agent/rights-agent-interface.ts`.
 */

export enum RightsRecheckReason {
  SCHEDULED_DUE = 'SCHEDULED_DUE',
  CONTENT_CHANGED = 'CONTENT_CHANGED',
  RIGHTS_DATA_CHANGED = 'RIGHTS_DATA_CHANGED',
  LANGUAGE_ADDED = 'LANGUAGE_ADDED',
  AUDIO_ADDED = 'AUDIO_ADDED',
  COMPONENT_ADDED = 'COMPONENT_ADDED',
  LEGAL_CHANGE = 'LEGAL_CHANGE',
  REVIEW_STALE = 'REVIEW_STALE',
  MANUAL_REQUEST = 'MANUAL_REQUEST',
  OTHER = 'OTHER',
}

export enum RightsRecheckStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  DISMISSED = 'DISMISSED',
}

export enum RightsRecheckSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  BLOCKING = 'BLOCKING',
}

export enum RightsRecheckReminderStage {
  NONE = 'NONE',
  LEAD_30 = 'LEAD_30',
  LEAD_7 = 'LEAD_7',
  DUE = 'DUE',
  OVERDUE = 'OVERDUE',
  ESCALATED = 'ESCALATED',
}

export enum RightsRecheckResolution {
  NEW_REVIEW_APPROVED = 'NEW_REVIEW_APPROVED',
  SUPERSEDED_BY_NEW_REVIEW = 'SUPERSEDED_BY_NEW_REVIEW',
  NO_CHANGE_NEEDED = 'NO_CHANGE_NEEDED',
  CONTENT_REVERTED = 'CONTENT_REVERTED',
  MANUALLY_CLOSED = 'MANUALLY_CLOSED',
  DISMISSED_NOT_APPLICABLE = 'DISMISSED_NOT_APPLICABLE',
  OTHER = 'OTHER',
}

export enum RightsRecheckTriggerSource {
  SCHEDULER = 'SCHEDULER',
  CONTENT_HASH = 'CONTENT_HASH',
  VERSION_CREATED = 'VERSION_CREATED',
  LEGAL_CHANGE = 'LEGAL_CHANGE',
  MANUAL = 'MANUAL',
}

export enum RightsRecheckEventType {
  TASK_CREATED = 'TASK_CREATED',
  REMINDER_SENT = 'REMINDER_SENT',
  SEVERITY_ESCALATED = 'SEVERITY_ESCALATED',
  SNOOZED = 'SNOOZED',
  STARTED = 'STARTED',
  COMPLETED = 'COMPLETED',
  DISMISSED = 'DISMISSED',
  REOPENED = 'REOPENED',
  DUE_DATE_CHANGED = 'DUE_DATE_CHANGED',
  LINKED_TO_REVIEW = 'LINKED_TO_REVIEW',
  NOTE_ADDED = 'NOTE_ADDED',
}

export enum RightsRecheckPolicy {
  INHERIT_REPORT = 'INHERIT_REPORT',
  FIXED_INTERVAL = 'FIXED_INTERVAL',
  MANUAL_ONLY = 'MANUAL_ONLY',
  PAUSED = 'PAUSED',
}

export enum RightsLegalChangeType {
  COPYRIGHT_TERM_CHANGE = 'COPYRIGHT_TERM_CHANGE',
  PUBLIC_DOMAIN_RULE_CHANGE = 'PUBLIC_DOMAIN_RULE_CHANGE',
  TRANSLATION_RIGHTS_CHANGE = 'TRANSLATION_RIGHTS_CHANGE',
  NEIGHBOURING_RIGHTS_CHANGE = 'NEIGHBOURING_RIGHTS_CHANGE',
  COURT_DECISION = 'COURT_DECISION',
  TREATY_RATIFICATION = 'TREATY_RATIFICATION',
  PLATFORM_POLICY_CHANGE = 'PLATFORM_POLICY_CHANGE',
  OTHER = 'OTHER',
}

export enum RightsLegalChangeStatus {
  DRAFT = 'DRAFT',
  APPLIED = 'APPLIED',
  ARCHIVED = 'ARCHIVED',
}

export enum RightsRecheckScanStatus {
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/** Row shape of the RightsRecheckTask table. */
export interface RightsRecheckTaskRecord {
  id: string;
  reason: RightsRecheckReason;
  status: RightsRecheckStatus;
  severity: RightsRecheckSeverity;
  source: RightsRecheckTriggerSource;
  rightsProfileId: string | null;
  rightsIntakeId: string | null;
  baselineReviewId: string | null;
  bookId: string | null;
  bookVersionId: string | null;
  legalChangeEventId: string | null;
  titleRu: string;
  descriptionRu: string;
  triggerCode: string | null;
  affectedCountryCodes: unknown;
  dueAt: Date;
  reminderStage: RightsRecheckReminderStage;
  remindersSentCount: number;
  lastReminderAt: Date | null;
  snoozedUntil: Date | null;
  snoozeReasonRu: string | null;
  startedAt: Date | null;
  startedByUserId: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  completionNotesRu: string | null;
  completedReviewId: string | null;
  dismissedAt: Date | null;
  dismissedByUserId: string | null;
  dismissReasonRu: string | null;
  resolution: RightsRecheckResolution | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  events?: RightsRecheckEventRecord[];
}

/** Row shape of the RightsRecheckEvent table. */
export interface RightsRecheckEventRecord {
  id: string;
  recheckTaskId: string;
  eventType: RightsRecheckEventType;
  fromStatus: RightsRecheckStatus | null;
  toStatus: RightsRecheckStatus | null;
  messageRu: string;
  payload: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

/** Row shape of the RightsLegalChangeEvent table. */
export interface RightsLegalChangeEventRecord {
  id: string;
  titleRu: string;
  descriptionRu: string;
  changeType: RightsLegalChangeType;
  status: RightsLegalChangeStatus;
  severity: RightsRecheckSeverity;
  jurisdictionCodes: unknown;
  appliesToAllCountries: boolean;
  effectiveFrom: Date | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  appliedAt: Date | null;
  appliedByUserId: string | null;
  affectedProfilesCount: number;
  createdTasksCount: number;
  archivedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Row shape of the RightsRecheckScanRun table. */
export interface RightsRecheckScanRunRecord {
  id: string;
  status: RightsRecheckScanStatus;
  source: RightsRecheckTriggerSource;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  profilesScanned: number;
  versionsScanned: number;
  tasksCreated: number;
  tasksEscalated: number;
  tasksAutoClosed: number;
  remindersSent: number;
  errorMessage: string | null;
  triggeredByUserId: string | null;
}

/** Narrow projection of RightsProfile with the Phase 18 columns. */
export interface RecheckProfileRecord {
  id: string;
  rightsIntakeId: string;
  status: string;
  isCurrent: boolean;
  nextReviewAt: Date | null;
  recheckPolicy: RightsRecheckPolicy;
  recheckIntervalDays: number | null;
  recheckPausedUntil: Date | null;
  recheckPauseReasonRu: string | null;
  lastRecheckScanAt: Date | null;
  createdAt: Date;
}

/**
 * Narrow projection of RightsReview with the Phase 18 chain columns. The fields below
 * `revisionNumber` are only selected by the review-chain queries.
 */
export interface RecheckReviewRecord {
  id: string;
  rightsProfileId: string;
  status: string;
  approvedAt: Date | null;
  nextReviewAt: Date | null;
  previousReviewId: string | null;
  chainRootReviewId: string | null;
  revisionNumber: number;
  overallStatus?: string;
  publicationGate?: string;
  confidence?: string;
  rightsReviewImportId?: string;
  approvedByUserId?: string | null;
  approvedByUser?: { id: string; name: string | null; email: string } | null;
  createdAt?: Date;
  rightsProfile?: { isCurrent: boolean } | null;
}

/** Narrow projection of BookVersion for staleness scanning. */
export interface RecheckVersionRecord {
  id: string;
  bookId: string;
  language: string;
  title?: string;
  status: string;
  rightsProfileId: string | null;
  approvedRightsReviewId: string | null;
  rightsRecheckRequired: boolean;
  rightsStaleDetectedAt: Date | null;
  rightsStaleReasonCode: string | null;
  rightsStaleReasonRu: string | null;
}

export interface RightsRecheckTaskDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsRecheckTaskRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsRecheckTaskRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsRecheckTaskRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsRecheckTaskRecord>;
  update(args: Record<string, unknown>): Promise<RightsRecheckTaskRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsRecheckEventDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsRecheckEventRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsRecheckEventRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsRecheckEventRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsRecheckEventRecord>;
  update(args: Record<string, unknown>): Promise<RightsRecheckEventRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsLegalChangeEventDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLegalChangeEventRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLegalChangeEventRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsLegalChangeEventRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLegalChangeEventRecord>;
  update(args: Record<string, unknown>): Promise<RightsLegalChangeEventRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsRecheckScanRunDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsRecheckScanRunRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsRecheckScanRunRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsRecheckScanRunRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsRecheckScanRunRecord>;
  update(args: Record<string, unknown>): Promise<RightsRecheckScanRunRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

/**
 * Existing models are reached through the same dynamic delegates: the Phase 18 columns
 * (`RightsProfile.recheckPolicy`, `RightsReview.revisionNumber`, …) are invisible to the
 * generated client, so a typed `select` on them would not compile.
 */
export interface RecheckProfileDelegate {
  findMany(args?: Record<string, unknown>): Promise<RecheckProfileRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RecheckProfileRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RecheckProfileRecord | null>;
  update(args: Record<string, unknown>): Promise<RecheckProfileRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RecheckReviewDelegate {
  findMany(args?: Record<string, unknown>): Promise<RecheckReviewRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RecheckReviewRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RecheckReviewRecord | null>;
  update(args: Record<string, unknown>): Promise<RecheckReviewRecord>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RecheckVersionDelegate {
  findMany(args?: Record<string, unknown>): Promise<RecheckVersionRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RecheckVersionRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RecheckVersionRecord | null>;
  count(args?: Record<string, unknown>): Promise<number>;
}

/** Narrow projection of RightsIntake used for navigation summaries. */
export interface RecheckIntakeRecord {
  id: string;
  candidateTitle: string;
  workflowStatus: string;
}

export interface RecheckIntakeDelegate {
  findUnique(args: Record<string, unknown>): Promise<RecheckIntakeRecord | null>;
  findFirst(args: Record<string, unknown>): Promise<RecheckIntakeRecord | null>;
}

/** Narrow projection of TerritoryDecision used by legal-change targeting and chain diffs. */
export interface RecheckTerritoryDecisionRecord {
  rightsProfileId: string;
  countryCode: string;
  finalStatus: string;
}

export interface RecheckTerritoryDecisionDelegate {
  findMany(args?: Record<string, unknown>): Promise<RecheckTerritoryDecisionRecord[]>;
}

/** Subset of the Prisma client the recheck module relies on. */
export interface RecheckDatabaseClient {
  rightsRecheckTask: RightsRecheckTaskDelegate;
  rightsRecheckEvent: RightsRecheckEventDelegate;
  rightsLegalChangeEvent: RightsLegalChangeEventDelegate;
  rightsRecheckScanRun: RightsRecheckScanRunDelegate;
  rightsProfile: RecheckProfileDelegate;
  rightsReview: RecheckReviewDelegate;
  bookVersion: RecheckVersionDelegate;
  rightsIntake: RecheckIntakeDelegate;
  territoryDecision: RecheckTerritoryDecisionDelegate;
  $transaction<T>(callback: (client: RecheckDatabaseClient) => Promise<T>): Promise<T>;
}

/** Narrow a Json column that should hold a list of strings. */
export const toCountryCodeArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};
