/**
 * Phase 19 models are reached through explicitly typed dynamic delegates: the generated
 * Prisma client is never regenerated in this repository, so it does not know about
 * RightsLawyer / RightsLawyerReview / RightsLegalOpinion / RightsLawyerReviewCondition /
 * RightsLawyerReviewEvent, nor about the new Phase 19 columns on RightsProfile and
 * RightsReview, nor about the new enum values (`lawyer`, `LAWYER_REVIEW_REQUIRED`, …).
 * Same pattern as `rights-recheck/rights-recheck-interface.ts`.
 */

export enum RightsRiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum RightsLawyerType {
  IN_HOUSE = 'IN_HOUSE',
  EXTERNAL_COUNSEL = 'EXTERNAL_COUNSEL',
  LAW_FIRM = 'LAW_FIRM',
  OTHER = 'OTHER',
}

export enum RightsLawyerReviewStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  APPROVED = 'APPROVED',
  APPROVED_WITH_CONDITIONS = 'APPROVED_WITH_CONDITIONS',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
}

export enum RightsLawyerDecision {
  APPROVED = 'APPROVED',
  APPROVED_WITH_CONDITIONS = 'APPROVED_WITH_CONDITIONS',
  REJECTED = 'REJECTED',
}

export enum RightsLawyerReviewTrigger {
  AGENT_REQUESTED = 'AGENT_REQUESTED',
  HIGH_RISK_POLICY = 'HIGH_RISK_POLICY',
  MANUAL_REQUEST = 'MANUAL_REQUEST',
  RIGHTS_CLAIM = 'RIGHTS_CLAIM',
  LEGAL_CHANGE = 'LEGAL_CHANGE',
  LICENSE_REQUIRED = 'LICENSE_REQUIRED',
  OTHER = 'OTHER',
}

export enum RightsLegalOpinionKind {
  EXTERNAL_COUNSEL_MEMO = 'EXTERNAL_COUNSEL_MEMO',
  IN_HOUSE_MEMO = 'IN_HOUSE_MEMO',
  EMAIL_CONFIRMATION = 'EMAIL_CONFIRMATION',
  COURT_FILING = 'COURT_FILING',
  REGULATOR_RESPONSE = 'REGULATOR_RESPONSE',
  OTHER = 'OTHER',
}

export enum RightsLawyerConditionStatus {
  PENDING = 'PENDING',
  SATISFIED = 'SATISFIED',
  WAIVED = 'WAIVED',
}

export enum RightsLawyerReviewEventType {
  REQUESTED = 'REQUESTED',
  ASSIGNED = 'ASSIGNED',
  UNASSIGNED = 'UNASSIGNED',
  STARTED = 'STARTED',
  OPINION_ATTACHED = 'OPINION_ATTACHED',
  OPINION_ARCHIVED = 'OPINION_ARCHIVED',
  CONDITION_ADDED = 'CONDITION_ADDED',
  CONDITION_SATISFIED = 'CONDITION_SATISFIED',
  CONDITION_WAIVED = 'CONDITION_WAIVED',
  DECIDED = 'DECIDED',
  WITHDRAWN = 'WITHDRAWN',
  REOPENED = 'REOPENED',
  EXPIRED = 'EXPIRED',
  DUE_DATE_CHANGED = 'DUE_DATE_CHANGED',
  NOTE_ADDED = 'NOTE_ADDED',
}

/**
 * Risk factor codes are a pure TypeScript concept: they live inside the `riskFactors` JSON
 * snapshot, never as a database enum, so adding one needs no migration.
 */
export enum RightsRiskFactorCode {
  PUBLICATION_GATE_BLOCK = 'PUBLICATION_GATE_BLOCK',
  OVERALL_STATUS_REJECTED = 'OVERALL_STATUS_REJECTED',
  CLAIM_ESCALATED_TO_LAWYER = 'CLAIM_ESCALATED_TO_LAWYER',
  CRITICAL_CLAIM_OPEN = 'CRITICAL_CLAIM_OPEN',
  AGENT_REQUESTED_LAWYER_REVIEW = 'AGENT_REQUESTED_LAWYER_REVIEW',
  CONFIDENCE_LOW = 'CONFIDENCE_LOW',
  OVERALL_STATUS_INSUFFICIENT_DATA = 'OVERALL_STATUS_INSUFFICIENT_DATA',
  OVERALL_STATUS_LICENSE_REQUIRED = 'OVERALL_STATUS_LICENSE_REQUIRED',
  UNCERTAIN_COMPONENT = 'UNCERTAIN_COMPONENT',
  COPYRIGHTED_COMPONENT_KEPT = 'COPYRIGHTED_COMPONENT_KEPT',
  LICENSE_REQUIRED_TERRITORY = 'LICENSE_REQUIRED_TERRITORY',
  UNRESOLVED_BLOCKING_ACTION = 'UNRESOLVED_BLOCKING_ACTION',
  PENDING_REVIEW_TERRITORY = 'PENDING_REVIEW_TERRITORY',
  CONFIDENCE_MEDIUM = 'CONFIDENCE_MEDIUM',
  DERIVATIVE_SOURCE_TEXT = 'DERIVATIVE_SOURCE_TEXT',
  CONTRIBUTOR_DEATH_YEAR_UNKNOWN = 'CONTRIBUTOR_DEATH_YEAR_UNKNOWN',
  BLOCKED_TERRITORY = 'BLOCKED_TERRITORY',
}

// ---------------------------------------------------------------------------
// Row shapes of the five Phase 19 tables
// ---------------------------------------------------------------------------

export interface LawyerUserRef {
  id: string;
  name: string | null;
  email: string;
}

/** Row shape of the RightsLawyer table. */
export interface RightsLawyerRecord {
  id: string;
  fullName: string;
  lawyerType: RightsLawyerType;
  organization: string | null;
  barId: string | null;
  email: string | null;
  phone: string | null;
  jurisdictionCodes: unknown;
  specializationRu: string | null;
  notesRu: string | null;
  userId: string | null;
  isActive: boolean;
  deactivatedAt: Date | null;
  deactivatedByUserId: string | null;
  deactivateReasonRu: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: (LawyerUserRef & { roles?: Array<{ role: { name: string } }> }) | null;
}

/** Row shape of the RightsLawyerReview table. */
export interface RightsLawyerReviewRecord {
  id: string;
  reviewNumber: string;
  status: RightsLawyerReviewStatus;
  trigger: RightsLawyerReviewTrigger;
  riskLevel: RightsRiskLevel;
  riskFactors: unknown;
  rightsProfileId: string | null;
  rightsIntakeId: string | null;
  rightsReviewId: string | null;
  bookId: string | null;
  bookVersionId: string | null;
  rightsClaimId: string | null;
  titleRu: string;
  questionRu: string;
  contextRu: string | null;
  affectedCountryCodes: unknown;
  affectedLanguages: unknown;
  affectedComponentIds: unknown;
  blocksApproval: boolean;
  requestedByUserId: string | null;
  requestedAt: Date;
  dueAt: Date | null;
  assignedLawyerId: string | null;
  assignedAt: Date | null;
  assignedByUserId: string | null;
  startedAt: Date | null;
  decision: RightsLawyerDecision | null;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  decidedLawyerId: string | null;
  lawyerNameSnapshot: string | null;
  opinionSummaryRu: string | null;
  restrictionsRu: string | null;
  approvedCountryCodes: unknown;
  blockedCountryCodes: unknown;
  validUntil: Date | null;
  expiredAt: Date | null;
  expiryNotifiedAt: Date | null;
  withdrawnAt: Date | null;
  withdrawnByUserId: string | null;
  withdrawReasonRu: string | null;
  reopenedAt: Date | null;
  reopenedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  assignedLawyer?: RightsLawyerRecord | null;
  conditions?: RightsLawyerReviewConditionRecord[];
  opinions?: RightsLegalOpinionRecord[];
  events?: RightsLawyerReviewEventRecord[];
  rightsIntake?: { id: string; candidateTitle: string; workflowStatus: string } | null;
  book?: { id: string; slug: string | null } | null;
  bookVersion?: { id: string; language: string } | null;
}

/** Row shape of the RightsLegalOpinion table. */
export interface RightsLegalOpinionRecord {
  id: string;
  rightsLawyerReviewId: string;
  kind: RightsLegalOpinionKind;
  titleRu: string;
  bodyRu: string;
  lawyerId: string | null;
  lawyerNameSnapshot: string | null;
  documentUrl: string | null;
  documentSha256: string | null;
  fileName: string | null;
  mimeType: string | null;
  issuedAt: Date | null;
  jurisdictionCodes: unknown;
  rightsEvidenceId: string | null;
  uploadedByUserId: string | null;
  archivedAt: Date | null;
  archivedByUserId: string | null;
  archiveReasonRu: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Row shape of the RightsLawyerReviewCondition table. */
export interface RightsLawyerReviewConditionRecord {
  id: string;
  rightsLawyerReviewId: string;
  code: string;
  textRu: string;
  status: RightsLawyerConditionStatus;
  isBlocking: boolean;
  affectedCountryCodes: unknown;
  satisfiedAt: Date | null;
  satisfiedByUserId: string | null;
  satisfiedNotesRu: string | null;
  waivedAt: Date | null;
  waivedByUserId: string | null;
  waiveReasonRu: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Row shape of the RightsLawyerReviewEvent table. */
export interface RightsLawyerReviewEventRecord {
  id: string;
  rightsLawyerReviewId: string;
  eventType: RightsLawyerReviewEventType;
  fromStatus: RightsLawyerReviewStatus | null;
  toStatus: RightsLawyerReviewStatus | null;
  messageRu: string;
  payload: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Narrow projections of existing models (Phase 19 columns are invisible to the client)
// ---------------------------------------------------------------------------

export interface LawyerProfileRecord {
  id: string;
  rightsIntakeId: string;
  status: string;
  isCurrent: boolean;
  overallStatus: string;
  publicationGate: string;
  confidence: string;
  riskLevel: RightsRiskLevel;
  riskFactors: unknown;
  riskAssessedAt: Date | null;
  lawyerReviewRequired: boolean;
  lawyerReviewBlocking: boolean;
  currentLawyerReviewId: string | null;
  lawyerApprovedAt: Date | null;
  lawyerApprovedLawyerId: string | null;
  lawyerApprovedLawyerName: string | null;
  lawyerOpinionValidUntil: Date | null;
}

export interface LawyerReviewSubjectRecord {
  id: string;
  rightsProfileId: string;
  status: string;
  lawyerReviewRequired: boolean;
  lawyerReviewId: string | null;
  lawyerApprovedAt: Date | null;
  lawyerNameSnapshot: string | null;
}

export interface LawyerIntakeRecord {
  id: string;
  candidateTitle: string;
  workflowStatus: string;
  sourceTextType: string | null;
  targetCountryCodes: unknown;
  targetLanguages: unknown;
}

export interface LawyerVersionRecord {
  id: string;
  bookId: string;
  language: string;
  status: string;
  rightsProfileId: string | null;
}

export interface LawyerComponentRecord {
  id: string;
  componentType: string;
  status: string;
  requiredAction: string;
  confidence: string | null;
  titleRu: string;
  /** WP-E.1: подгружается только ради вопроса «оценивал ли агент компонент по странам вообще». */
  territoryAssessments?: Array<{ countryCode: string }>;
}

export interface LawyerTerritoryDecisionRecord {
  countryCode: string;
  finalStatus: string;
}

export interface LawyerActionRecord {
  actionType: string;
  status: string;
  isBlocking: boolean;
}

export interface LawyerContributorRecord {
  role: string;
  person?: { fullName: string; deathYear: number | null } | null;
}

export interface LawyerClaimRecord {
  id: string;
  status: string;
  severity: string;
  requiresLawyerReview: boolean;
}

export interface LawyerEvidenceRecord {
  id: string;
  rightsProfileId: string;
  evidenceType: string;
}

export interface LawyerSourceEditionRecord {
  rightsProfileId: string;
  sourceTextType: string | null;
}

export interface LawyerUserRecord {
  id: string;
  name: string | null;
  email: string;
  roles?: Array<{ role: { name: string } }>;
}

// ---------------------------------------------------------------------------
// Delegates
// ---------------------------------------------------------------------------

export interface RightsLawyerDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLawyerRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLawyerRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsLawyerRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLawyerRecord>;
  update(args: Record<string, unknown>): Promise<RightsLawyerRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsLawyerReviewDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLawyerReviewRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLawyerReviewRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsLawyerReviewRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLawyerReviewRecord>;
  update(args: Record<string, unknown>): Promise<RightsLawyerReviewRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsLegalOpinionDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLegalOpinionRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLegalOpinionRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsLegalOpinionRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLegalOpinionRecord>;
  update(args: Record<string, unknown>): Promise<RightsLegalOpinionRecord>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsLawyerReviewConditionDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLawyerReviewConditionRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLawyerReviewConditionRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsLawyerReviewConditionRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLawyerReviewConditionRecord>;
  update(args: Record<string, unknown>): Promise<RightsLawyerReviewConditionRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsLawyerReviewEventDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLawyerReviewEventRecord[]>;
  create(args: Record<string, unknown>): Promise<RightsLawyerReviewEventRecord>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface LawyerProfileDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerProfileRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<LawyerProfileRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<LawyerProfileRecord | null>;
  update(args: Record<string, unknown>): Promise<LawyerProfileRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface LawyerSubjectReviewDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerReviewSubjectRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<LawyerReviewSubjectRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<LawyerReviewSubjectRecord | null>;
  update(args: Record<string, unknown>): Promise<LawyerReviewSubjectRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

export interface LawyerIntakeDelegate {
  findUnique(args: Record<string, unknown>): Promise<LawyerIntakeRecord | null>;
  findFirst(args: Record<string, unknown>): Promise<LawyerIntakeRecord | null>;
  update(args: Record<string, unknown>): Promise<LawyerIntakeRecord>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

export interface LawyerVersionDelegate {
  findUnique(args: Record<string, unknown>): Promise<LawyerVersionRecord | null>;
  findFirst(args: Record<string, unknown>): Promise<LawyerVersionRecord | null>;
}

export interface LawyerComponentDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerComponentRecord[]>;
}

export interface LawyerTerritoryDecisionDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerTerritoryDecisionRecord[]>;
}

export interface LawyerActionDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerActionRecord[]>;
}

export interface LawyerContributorDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerContributorRecord[]>;
}

export interface LawyerClaimDelegate {
  findMany(args?: Record<string, unknown>): Promise<LawyerClaimRecord[]>;
}

export interface LawyerEvidenceDelegate {
  create(args: Record<string, unknown>): Promise<LawyerEvidenceRecord>;
}

export interface LawyerSourceEditionDelegate {
  findUnique(args: Record<string, unknown>): Promise<LawyerSourceEditionRecord | null>;
  findFirst(args: Record<string, unknown>): Promise<LawyerSourceEditionRecord | null>;
}

export interface LawyerUserDelegate {
  findUnique(args: Record<string, unknown>): Promise<LawyerUserRecord | null>;
}

/** Subset of the Prisma client the lawyer module relies on. */
export interface LawyerDatabaseClient {
  rightsLawyer: RightsLawyerDelegate;
  rightsLawyerReview: RightsLawyerReviewDelegate;
  rightsLegalOpinion: RightsLegalOpinionDelegate;
  rightsLawyerReviewCondition: RightsLawyerReviewConditionDelegate;
  rightsLawyerReviewEvent: RightsLawyerReviewEventDelegate;
  rightsProfile: LawyerProfileDelegate;
  rightsReview: LawyerSubjectReviewDelegate;
  rightsIntake: LawyerIntakeDelegate;
  bookVersion: LawyerVersionDelegate;
  rightsComponent: LawyerComponentDelegate;
  territoryDecision: LawyerTerritoryDecisionDelegate;
  rightsAction: LawyerActionDelegate;
  rightsProfileContributor: LawyerContributorDelegate;
  rightsClaim: LawyerClaimDelegate;
  rightsEvidence: LawyerEvidenceDelegate;
  sourceEdition: LawyerSourceEditionDelegate;
  user: LawyerUserDelegate;
  $transaction<T>(callback: (client: LawyerDatabaseClient) => Promise<T>): Promise<T>;
}

/** Narrow a Json column that should hold a list of strings. */
export const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};
