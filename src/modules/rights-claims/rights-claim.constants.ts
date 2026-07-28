import { RightsClaimStatus } from './rights-claim-interface';

/** Statuses in which a claim is considered open (still being worked on). */
export const OPEN_CLAIM_STATUSES: readonly RightsClaimStatus[] = [
  RightsClaimStatus.RECEIVED,
  RightsClaimStatus.UNDER_REVIEW,
  RightsClaimStatus.ACTION_REQUIRED,
  RightsClaimStatus.AWAITING_CLAIMANT,
  RightsClaimStatus.CONTENT_REMOVED,
  RightsClaimStatus.CONTENT_RESTRICTED,
  RightsClaimStatus.COUNTER_NOTICE_FILED,
  RightsClaimStatus.ESCALATED_TO_LAWYER,
];

/** Terminal statuses. */
export const CLOSED_CLAIM_STATUSES: readonly RightsClaimStatus[] = [
  RightsClaimStatus.RESOLVED_VALID,
  RightsClaimStatus.RESOLVED_INVALID,
  RightsClaimStatus.WITHDRAWN,
  RightsClaimStatus.CLOSED,
];

/** A claim in one of these statuses with `blocksPublication = true` blocks the publication gate. */
export const PUBLICATION_BLOCKING_STATUSES: readonly RightsClaimStatus[] = OPEN_CLAIM_STATUSES;

/** A deadline closer than this many days produces a gate warning. */
export const CLAIM_DEADLINE_WARNING_DAYS = 7;

/** Block scopes that require a `bookVersionId`. */
export const VERSION_SCOPED_BLOCK_SCOPES: readonly string[] = [
  'LANGUAGE_EDITION',
  'TEXT_READER',
  'DOWNLOADS',
  'AUDIO',
  'SPECIFIC_ASSET',
];

export const CLAIM_ACCESS_BLOCK_REASON_CODE = 'BLOCKED_BY_RIGHTS_CLAIM';
export const CLAIM_ACCESS_BLOCK_MESSAGE =
  'Content is temporarily unavailable due to a rights claim.';
export const CLAIM_ACCESS_BLOCK_MESSAGE_RU =
  'Контент временно недоступен из-за претензии правообладателя.';

/** A claim resolved less than this many days ago still produces an informational warning. */
export const CLAIM_RECENTLY_RESOLVED_DAYS = 30;

/** Severity ordering used for sorting and for computing the worst severity of a set. */
export const CLAIM_SEVERITY_RANK: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** Allowed status transitions. A transition outside this matrix is rejected with 400. */
export const ALLOWED_STATUS_TRANSITIONS: Record<RightsClaimStatus, RightsClaimStatus[]> = {
  [RightsClaimStatus.RECEIVED]: [
    RightsClaimStatus.UNDER_REVIEW,
    RightsClaimStatus.ACTION_REQUIRED,
    RightsClaimStatus.ESCALATED_TO_LAWYER,
    RightsClaimStatus.RESOLVED_INVALID,
    RightsClaimStatus.WITHDRAWN,
    RightsClaimStatus.CLOSED,
  ],
  [RightsClaimStatus.UNDER_REVIEW]: [
    RightsClaimStatus.ACTION_REQUIRED,
    RightsClaimStatus.AWAITING_CLAIMANT,
    RightsClaimStatus.CONTENT_REMOVED,
    RightsClaimStatus.CONTENT_RESTRICTED,
    RightsClaimStatus.ESCALATED_TO_LAWYER,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
    RightsClaimStatus.WITHDRAWN,
  ],
  [RightsClaimStatus.ACTION_REQUIRED]: [
    RightsClaimStatus.UNDER_REVIEW,
    RightsClaimStatus.AWAITING_CLAIMANT,
    RightsClaimStatus.CONTENT_REMOVED,
    RightsClaimStatus.CONTENT_RESTRICTED,
    RightsClaimStatus.ESCALATED_TO_LAWYER,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
    RightsClaimStatus.WITHDRAWN,
  ],
  [RightsClaimStatus.AWAITING_CLAIMANT]: [
    RightsClaimStatus.UNDER_REVIEW,
    RightsClaimStatus.ACTION_REQUIRED,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
    RightsClaimStatus.WITHDRAWN,
    RightsClaimStatus.CLOSED,
  ],
  [RightsClaimStatus.CONTENT_REMOVED]: [
    RightsClaimStatus.COUNTER_NOTICE_FILED,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
    RightsClaimStatus.ESCALATED_TO_LAWYER,
  ],
  [RightsClaimStatus.CONTENT_RESTRICTED]: [
    RightsClaimStatus.COUNTER_NOTICE_FILED,
    RightsClaimStatus.CONTENT_REMOVED,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
    RightsClaimStatus.ESCALATED_TO_LAWYER,
  ],
  [RightsClaimStatus.COUNTER_NOTICE_FILED]: [
    RightsClaimStatus.UNDER_REVIEW,
    RightsClaimStatus.ESCALATED_TO_LAWYER,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
  ],
  [RightsClaimStatus.ESCALATED_TO_LAWYER]: [
    RightsClaimStatus.UNDER_REVIEW,
    RightsClaimStatus.ACTION_REQUIRED,
    RightsClaimStatus.CONTENT_REMOVED,
    RightsClaimStatus.CONTENT_RESTRICTED,
    RightsClaimStatus.RESOLVED_VALID,
    RightsClaimStatus.RESOLVED_INVALID,
  ],
  [RightsClaimStatus.RESOLVED_VALID]: [RightsClaimStatus.CLOSED, RightsClaimStatus.UNDER_REVIEW],
  [RightsClaimStatus.RESOLVED_INVALID]: [RightsClaimStatus.CLOSED, RightsClaimStatus.UNDER_REVIEW],
  [RightsClaimStatus.WITHDRAWN]: [RightsClaimStatus.CLOSED, RightsClaimStatus.UNDER_REVIEW],
  [RightsClaimStatus.CLOSED]: [],
};

/** Statuses a claim can be reopened from. */
export const REOPENABLE_STATUSES: readonly RightsClaimStatus[] = [
  RightsClaimStatus.RESOLVED_VALID,
  RightsClaimStatus.RESOLVED_INVALID,
  RightsClaimStatus.WITHDRAWN,
  RightsClaimStatus.CLOSED,
];

export const isOpenClaimStatus = (status: RightsClaimStatus): boolean =>
  OPEN_CLAIM_STATUSES.includes(status);
