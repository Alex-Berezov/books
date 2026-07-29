import {
  RECHECK_DEFAULT_INTERVAL_DAYS,
  RECHECK_OVERDUE_GRACE_DAYS_DEFAULT,
  RECHECK_REMINDER_LEAD_DAYS_DEFAULT,
  STALE_REASON_TO_RECHECK_REASON,
} from './rights-recheck.constants';
import {
  RightsRecheckPolicy,
  RightsRecheckReason,
  RightsRecheckReminderStage,
  RightsRecheckSeverity,
} from './rights-recheck-interface';
import type {
  RecheckProfileRecord,
  RecheckReviewRecord,
  RightsRecheckTaskRecord,
} from './rights-recheck-interface';

export const MS_PER_DAY = 86_400_000;

export const addDays = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * MS_PER_DAY);

/** Config slice the pure date helpers need. Kept explicit so the functions stay testable. */
export interface RecheckDateConfig {
  defaultIntervalDays: number;
  leadDays: readonly number[];
  graceDays: number;
}

export const DEFAULT_RECHECK_DATE_CONFIG: RecheckDateConfig = {
  defaultIntervalDays: RECHECK_DEFAULT_INTERVAL_DAYS,
  leadDays: RECHECK_REMINDER_LEAD_DAYS_DEFAULT,
  graceDays: RECHECK_OVERDUE_GRACE_DAYS_DEFAULT,
};

/** Profile fields the scheduled-due computation reads. */
export type ScheduledDueProfile = Pick<
  RecheckProfileRecord,
  'nextReviewAt' | 'recheckPolicy' | 'recheckIntervalDays' | 'recheckPausedUntil' | 'createdAt'
>;

/** Review fields the scheduled-due computation reads. */
export type ScheduledDueReview = Pick<RecheckReviewRecord, 'approvedAt' | 'nextReviewAt'>;

/**
 * Planned recheck date of a profile. `null` means "no scheduled task": either the policy
 * forbids one (MANUAL_ONLY / active PAUSED) or no date is known at all.
 */
export const computeScheduledDueAt = (
  profile: ScheduledDueProfile,
  approvedReview: ScheduledDueReview | null,
  config: RecheckDateConfig,
  now: Date = new Date(),
): Date | null => {
  const policy = profile.recheckPolicy;

  if (policy === RightsRecheckPolicy.MANUAL_ONLY) {
    return null;
  }

  if (policy === RightsRecheckPolicy.PAUSED) {
    const pausedUntil = profile.recheckPausedUntil;
    // An expired (or missing) pause behaves exactly like INHERIT_REPORT.
    if (pausedUntil && pausedUntil.getTime() > now.getTime()) {
      return null;
    }
    return profile.nextReviewAt ?? approvedReview?.nextReviewAt ?? null;
  }

  if (policy === RightsRecheckPolicy.FIXED_INTERVAL) {
    const intervalDays = profile.recheckIntervalDays ?? config.defaultIntervalDays;
    const base = approvedReview?.approvedAt ?? profile.createdAt;
    return addDays(base, intervalDays);
  }

  // INHERIT_REPORT
  return profile.nextReviewAt ?? approvedReview?.nextReviewAt ?? null;
};

/** Ordering of reminder stages — a reminder is only sent when the stage moves right. */
export const REMINDER_STAGE_ORDER: readonly RightsRecheckReminderStage[] = [
  RightsRecheckReminderStage.NONE,
  RightsRecheckReminderStage.LEAD_30,
  RightsRecheckReminderStage.LEAD_7,
  RightsRecheckReminderStage.DUE,
  RightsRecheckReminderStage.OVERDUE,
  RightsRecheckReminderStage.ESCALATED,
];

export const reminderStageRank = (stage: RightsRecheckReminderStage): number => {
  const index = REMINDER_STAGE_ORDER.indexOf(stage);
  return index === -1 ? 0 : index;
};

/**
 * Reminder ladder. `leadDays` is expected in descending order — the first entry opens the
 * first reminder, the last one opens the final pre-due reminder.
 */
export const computeReminderStage = (
  dueAt: Date,
  now: Date,
  leadDays: readonly number[],
  graceDays: number,
): RightsRecheckReminderStage => {
  const due = dueAt.getTime();
  const current = now.getTime();

  if (current >= due + graceDays * MS_PER_DAY) {
    return RightsRecheckReminderStage.ESCALATED;
  }

  if (current >= due) {
    // The first 24 hours after the due date read as DUE, everything later as OVERDUE.
    return current - due < MS_PER_DAY
      ? RightsRecheckReminderStage.DUE
      : RightsRecheckReminderStage.OVERDUE;
  }

  const sorted = [...leadDays].sort((a, b) => b - a);
  const firstLead = sorted[0] ?? 0;
  const lastLead = sorted[sorted.length - 1] ?? 0;

  if (current >= due - lastLead * MS_PER_DAY) {
    return RightsRecheckReminderStage.LEAD_7;
  }

  if (current >= due - firstLead * MS_PER_DAY) {
    return RightsRecheckReminderStage.LEAD_30;
  }

  return RightsRecheckReminderStage.NONE;
};

export const SEVERITY_ORDER: readonly RightsRecheckSeverity[] = [
  RightsRecheckSeverity.INFO,
  RightsRecheckSeverity.WARNING,
  RightsRecheckSeverity.BLOCKING,
];

export const severityRank = (severity: RightsRecheckSeverity): number => {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? 0 : index;
};

/** Task fields the severity computation reads. */
export type SeverityTask = Pick<RightsRecheckTaskRecord, 'reason' | 'severity' | 'dueAt'>;

/**
 * Effective severity of a task at a given moment. Severity never goes down: a task that is
 * already BLOCKING (a manual escalation, a blocking legal change) stays BLOCKING.
 */
export const computeTaskSeverity = (
  task: SeverityTask,
  now: Date,
  graceDays: number,
): RightsRecheckSeverity => {
  const due = task.dueAt.getTime();
  const current = now.getTime();

  let dateDriven: RightsRecheckSeverity;
  if (current < due) {
    dateDriven = RightsRecheckSeverity.INFO;
  } else if (current < due + graceDays * MS_PER_DAY) {
    dateDriven = RightsRecheckSeverity.WARNING;
  } else {
    dateDriven = RightsRecheckSeverity.BLOCKING;
  }

  return severityRank(task.severity) >= severityRank(dateDriven) ? task.severity : dateDriven;
};

/** Phase 8 stale reason code → recheck reason. Unknown codes and null map to CONTENT_CHANGED. */
export const staleReasonToRecheckReason = (
  staleReasonCode: string | null | undefined,
): RightsRecheckReason =>
  STALE_REASON_TO_RECHECK_REASON[staleReasonCode ?? ''] ?? RightsRecheckReason.CONTENT_CHANGED;

/** Whole days remaining until `dueAt`; negative once the task is overdue. */
export const daysUntil = (dueAt: Date, now: Date): number =>
  Math.ceil((dueAt.getTime() - now.getTime()) / MS_PER_DAY);

/** Parses a comma-separated env value like `30,7` into a descending list of positive days. */
export const parseLeadDays = (raw: string | undefined, fallback: readonly number[]): number[] => {
  if (!raw) return [...fallback];
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
  return parsed.length > 0 ? parsed : [...fallback];
};

/** Reads a positive-integer env value, falling back to a default when absent or malformed. */
export const parsePositiveInt = (raw: unknown, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
