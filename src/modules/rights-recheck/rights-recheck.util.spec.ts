import {
  RightsRecheckPolicy,
  RightsRecheckReason,
  RightsRecheckReminderStage,
  RightsRecheckSeverity,
} from './rights-recheck-interface';
import {
  addDays,
  computeReminderStage,
  computeScheduledDueAt,
  computeTaskSeverity,
  daysUntil,
  parseLeadDays,
  parsePositiveInt,
  staleReasonToRecheckReason,
  type RecheckDateConfig,
  type ScheduledDueProfile,
} from './rights-recheck.util';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const CONFIG: RecheckDateConfig = { defaultIntervalDays: 365, leadDays: [30, 7], graceDays: 30 };

const profile = (overrides: Partial<ScheduledDueProfile> = {}): ScheduledDueProfile => ({
  nextReviewAt: null,
  recheckPolicy: RightsRecheckPolicy.INHERIT_REPORT,
  recheckIntervalDays: null,
  recheckPausedUntil: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('computeScheduledDueAt', () => {
  it('returns null for MANUAL_ONLY', () => {
    const result = computeScheduledDueAt(
      profile({
        recheckPolicy: RightsRecheckPolicy.MANUAL_ONLY,
        nextReviewAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
      null,
      CONFIG,
      NOW,
    );
    expect(result).toBeNull();
  });

  it('returns null for PAUSED with a pause that is still active', () => {
    const result = computeScheduledDueAt(
      profile({
        recheckPolicy: RightsRecheckPolicy.PAUSED,
        recheckPausedUntil: new Date('2026-12-31T00:00:00.000Z'),
        nextReviewAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
      null,
      CONFIG,
      NOW,
    );
    expect(result).toBeNull();
  });

  it('treats an expired PAUSED policy as INHERIT_REPORT', () => {
    const nextReviewAt = new Date('2026-08-01T00:00:00.000Z');
    const result = computeScheduledDueAt(
      profile({
        recheckPolicy: RightsRecheckPolicy.PAUSED,
        recheckPausedUntil: new Date('2026-07-01T00:00:00.000Z'),
        nextReviewAt,
      }),
      null,
      CONFIG,
      NOW,
    );
    expect(result).toEqual(nextReviewAt);
  });

  it('prefers the profile nextReviewAt over the review one for INHERIT_REPORT', () => {
    const profileDate = new Date('2026-08-01T00:00:00.000Z');
    const result = computeScheduledDueAt(
      profile({ nextReviewAt: profileDate }),
      { approvedAt: null, nextReviewAt: new Date('2027-01-01T00:00:00.000Z') },
      CONFIG,
      NOW,
    );
    expect(result).toEqual(profileDate);
  });

  it('falls back to the review nextReviewAt when the profile has none', () => {
    const reviewDate = new Date('2027-01-01T00:00:00.000Z');
    const result = computeScheduledDueAt(
      profile(),
      { approvedAt: null, nextReviewAt: reviewDate },
      CONFIG,
      NOW,
    );
    expect(result).toEqual(reviewDate);
  });

  it('returns null for INHERIT_REPORT when neither date is known', () => {
    expect(computeScheduledDueAt(profile(), null, CONFIG, NOW)).toBeNull();
  });

  it('computes approvedAt + intervalDays for FIXED_INTERVAL', () => {
    const approvedAt = new Date('2026-03-01T00:00:00.000Z');
    const result = computeScheduledDueAt(
      profile({ recheckPolicy: RightsRecheckPolicy.FIXED_INTERVAL, recheckIntervalDays: 90 }),
      { approvedAt, nextReviewAt: null },
      CONFIG,
      NOW,
    );
    expect(result).toEqual(addDays(approvedAt, 90));
  });

  it('falls back to profile.createdAt and the default interval for FIXED_INTERVAL', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const result = computeScheduledDueAt(
      profile({ recheckPolicy: RightsRecheckPolicy.FIXED_INTERVAL, createdAt }),
      null,
      CONFIG,
      NOW,
    );
    expect(result).toEqual(addDays(createdAt, 365));
  });
});

describe('computeReminderStage', () => {
  const dueAt = new Date('2026-09-01T00:00:00.000Z');

  it('returns NONE well before the first lead window', () => {
    expect(computeReminderStage(dueAt, addDays(dueAt, -60), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.NONE,
    );
  });

  it('returns LEAD_30 inside the first lead window', () => {
    expect(computeReminderStage(dueAt, addDays(dueAt, -30), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.LEAD_30,
    );
    expect(computeReminderStage(dueAt, addDays(dueAt, -8), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.LEAD_30,
    );
  });

  it('returns LEAD_7 inside the final lead window', () => {
    expect(computeReminderStage(dueAt, addDays(dueAt, -7), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.LEAD_7,
    );
    expect(computeReminderStage(dueAt, addDays(dueAt, -1), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.LEAD_7,
    );
  });

  it('returns DUE on the due date and OVERDUE exactly 24 hours later', () => {
    expect(computeReminderStage(dueAt, dueAt, [30, 7], 30)).toBe(RightsRecheckReminderStage.DUE);
    expect(
      computeReminderStage(dueAt, new Date(dueAt.getTime() + 23 * 3_600_000), [30, 7], 30),
    ).toBe(RightsRecheckReminderStage.DUE);
    expect(computeReminderStage(dueAt, addDays(dueAt, 1), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.OVERDUE,
    );
  });

  it('returns ESCALATED past the grace period', () => {
    expect(computeReminderStage(dueAt, addDays(dueAt, 30), [30, 7], 30)).toBe(
      RightsRecheckReminderStage.ESCALATED,
    );
  });
});

describe('computeTaskSeverity', () => {
  const dueAt = new Date('2026-09-01T00:00:00.000Z');

  it('is INFO before the due date, WARNING inside the grace period, BLOCKING after it', () => {
    const task = {
      reason: RightsRecheckReason.SCHEDULED_DUE,
      severity: RightsRecheckSeverity.INFO,
      dueAt,
    };
    expect(computeTaskSeverity(task, addDays(dueAt, -1), 30)).toBe(RightsRecheckSeverity.INFO);
    expect(computeTaskSeverity(task, addDays(dueAt, 5), 30)).toBe(RightsRecheckSeverity.WARNING);
    expect(computeTaskSeverity(task, addDays(dueAt, 31), 30)).toBe(RightsRecheckSeverity.BLOCKING);
  });

  it('keeps a BLOCKING legal-change task blocking before its due date', () => {
    const task = {
      reason: RightsRecheckReason.LEGAL_CHANGE,
      severity: RightsRecheckSeverity.BLOCKING,
      dueAt,
    };
    expect(computeTaskSeverity(task, addDays(dueAt, -20), 30)).toBe(RightsRecheckSeverity.BLOCKING);
  });

  it('never lowers an already-escalated manual task', () => {
    const task = {
      reason: RightsRecheckReason.MANUAL_REQUEST,
      severity: RightsRecheckSeverity.WARNING,
      dueAt,
    };
    expect(computeTaskSeverity(task, addDays(dueAt, -10), 30)).toBe(RightsRecheckSeverity.WARNING);
  });
});

describe('staleReasonToRecheckReason', () => {
  it('maps audio codes to AUDIO_ADDED', () => {
    expect(staleReasonToRecheckReason('AUDIO_CHAPTER_CREATED')).toBe(
      RightsRecheckReason.AUDIO_ADDED,
    );
  });

  it('maps source edition changes to RIGHTS_DATA_CHANGED', () => {
    expect(staleReasonToRecheckReason('SOURCE_EDITION_CHANGED')).toBe(
      RightsRecheckReason.RIGHTS_DATA_CHANGED,
    );
  });

  it('maps unknown codes and null to CONTENT_CHANGED', () => {
    expect(staleReasonToRecheckReason('SOMETHING_ELSE')).toBe(RightsRecheckReason.CONTENT_CHANGED);
    expect(staleReasonToRecheckReason(null)).toBe(RightsRecheckReason.CONTENT_CHANGED);
    expect(staleReasonToRecheckReason(undefined)).toBe(RightsRecheckReason.CONTENT_CHANGED);
  });
});

describe('helpers', () => {
  it('daysUntil is negative for overdue tasks', () => {
    const dueAt = new Date('2026-07-25T12:00:00.000Z');
    expect(daysUntil(dueAt, NOW)).toBe(-5);
  });

  it('parseLeadDays sorts descending and falls back on malformed input', () => {
    expect(parseLeadDays('7,30', [30, 7])).toEqual([30, 7]);
    expect(parseLeadDays('', [30, 7])).toEqual([30, 7]);
    expect(parseLeadDays('abc', [30, 7])).toEqual([30, 7]);
    expect(parseLeadDays(undefined, [14, 3])).toEqual([14, 3]);
  });

  it('parsePositiveInt rejects zero, negatives and NaN', () => {
    expect(parsePositiveInt('42', 7)).toBe(42);
    expect(parsePositiveInt('0', 7)).toBe(7);
    expect(parsePositiveInt('-1', 7)).toBe(7);
    expect(parsePositiveInt(undefined, 7)).toBe(7);
  });
});
