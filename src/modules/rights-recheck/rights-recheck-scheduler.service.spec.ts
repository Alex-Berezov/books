import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import { BackgroundJobsRegistry } from '../background-jobs/background-jobs.registry';
import { RightsRecheckSchedulerService } from './rights-recheck-scheduler.service';
import { RightsRecheckService } from './rights-recheck.service';
import {
  RightsRecheckEventType,
  RightsRecheckPolicy,
  RightsRecheckReason,
  RightsRecheckResolution,
  RightsRecheckScanStatus,
  RightsRecheckSeverity,
  RightsRecheckStatus,
  RightsRecheckTriggerSource,
  type RightsRecheckTaskRecord,
} from './rights-recheck-interface';
import { addDays } from './rights-recheck.util';

const NOW = new Date();

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  rightsIntakeId: 'intake-1',
  status: 'APPROVED',
  isCurrent: true,
  nextReviewAt: null,
  recheckPolicy: RightsRecheckPolicy.INHERIT_REPORT,
  recheckIntervalDays: null,
  recheckPausedUntil: null,
  recheckPauseReasonRu: null,
  lastRecheckScanAt: null,
  createdAt: NOW,
  ...overrides,
});

const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'v1',
  bookId: 'b1',
  language: 'en',
  status: 'published',
  rightsProfileId: 'profile-1',
  approvedRightsReviewId: 'review-1',
  rightsRecheckRequired: true,
  rightsStaleDetectedAt: NOW,
  rightsStaleReasonCode: 'CHAPTER_UPDATED',
  rightsStaleReasonRu: 'Изменена глава',
  ...overrides,
});

const task = (overrides: Partial<RightsRecheckTaskRecord> = {}): RightsRecheckTaskRecord => ({
  id: 'task-1',
  reason: RightsRecheckReason.SCHEDULED_DUE,
  status: RightsRecheckStatus.PENDING,
  severity: RightsRecheckSeverity.INFO,
  source: RightsRecheckTriggerSource.SCHEDULER,
  rightsProfileId: 'profile-1',
  rightsIntakeId: 'intake-1',
  baselineReviewId: null,
  bookId: null,
  bookVersionId: null,
  legalChangeEventId: null,
  titleRu: 'Плановая перепроверка прав',
  descriptionRu: 'Описание',
  triggerCode: null,
  affectedCountryCodes: null,
  dueAt: addDays(NOW, 10),
  reminderStage: 'NONE' as RightsRecheckTaskRecord['reminderStage'],
  remindersSentCount: 0,
  lastReminderAt: null,
  snoozedUntil: null,
  snoozeReasonRu: null,
  startedAt: null,
  startedByUserId: null,
  completedAt: null,
  completedByUserId: null,
  completionNotesRu: null,
  completedReviewId: null,
  dismissedAt: null,
  dismissedByUserId: null,
  dismissReasonRu: null,
  resolution: null,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

interface Stub {
  rightsRecheckTask: Record<string, jest.Mock>;
  rightsRecheckEvent: Record<string, jest.Mock>;
  rightsLegalChangeEvent: Record<string, jest.Mock>;
  rightsRecheckScanRun: Record<string, jest.Mock>;
  rightsProfile: Record<string, jest.Mock>;
  rightsReview: Record<string, jest.Mock>;
  bookVersion: Record<string, jest.Mock>;
  rightsIntake: Record<string, jest.Mock>;
  territoryDecision: Record<string, jest.Mock>;
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
}

const createStub = (): Stub => {
  const stub: Stub = {
    rightsRecheckTask: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(task({ id: 'created-task' })),
      update: jest.fn().mockResolvedValue(task()),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsRecheckEvent: { create: jest.fn().mockResolvedValue({}) },
    rightsLegalChangeEvent: {},
    // Stateful on purpose: `finishRun` writes with `updateMany` and then re-reads the row with
    // `findUnique`, so a stub that answered both from fixed literals would report a SUCCEEDED
    // run no matter what was actually written — including when the write was refused.
    rightsRecheckScanRun: (() => {
      const row: Record<string, unknown> = {
        id: 'run-1',
        status: RightsRecheckScanStatus.RUNNING,
        source: RightsRecheckTriggerSource.SCHEDULER,
        startedAt: NOW,
        finishedAt: null,
        durationMs: null,
        profilesScanned: 0,
        versionsScanned: 0,
        tasksCreated: 0,
        tasksEscalated: 0,
        tasksAutoClosed: 0,
        remindersSent: 0,
        errorMessage: null,
        triggeredByUserId: null,
      };
      return {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data, { id: 'run-1' });
          return Promise.resolve({ ...row });
        }),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ ...row, ...data }),
          ),
        // `count: 1` — this run still owns the slot. A zero means another instance reclaimed
        // it as abandoned, and then the verdict must NOT be written: tests that want that case
        // override this mock.
        updateMany: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return Promise.resolve({ count: 1 });
        }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...row })),
        count: jest.fn().mockResolvedValue(0),
      };
    })(),
    rightsProfile: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(profile()),
      update: jest.fn().mockResolvedValue({}),
    },
    rightsReview: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    bookVersion: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    rightsIntake: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'intake-1',
        candidateTitle: 'Одиссея',
        workflowStatus: 'APPROVED',
      }),
    },
    territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
  };
  stub.$transaction.mockImplementation((callback: (client: Stub) => Promise<unknown>) =>
    callback(stub),
  );
  return stub;
};

const configWith = (values: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('RightsRecheckSchedulerService', () => {
  let stub: Stub;
  let notifications: { create: jest.Mock };
  let recheckService: RightsRecheckService;
  let scheduler: RightsRecheckSchedulerService;

  const build = (config: ConfigService = configWith()): void => {
    recheckService = new RightsRecheckService(
      stub as unknown as PrismaService,
      notifications as unknown as RightsNotificationsService,
      config,
    );
    scheduler = new RightsRecheckSchedulerService(
      stub as unknown as PrismaService,
      recheckService,
      notifications as unknown as RightsNotificationsService,
      config,
      new BackgroundJobsRegistry(),
    );
  };

  beforeEach(() => {
    stub = createStub();
    notifications = { create: jest.fn().mockResolvedValue({}) };
    build();
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
  });

  it('opens and closes a scan run with SUCCEEDED and populated counters', async () => {
    const result = await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, 'admin-1');

    expect(stub.rightsRecheckScanRun.create).toHaveBeenCalled();
    expect(result.status).toBe(RightsRecheckScanStatus.SUCCEEDED);
    // Guarded by `status: RUNNING`: the verdict is written only while this run owns the slot.
    expect(stub.rightsRecheckScanRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: RightsRecheckScanStatus.RUNNING }),
        data: expect.objectContaining({ status: RightsRecheckScanStatus.SUCCEEDED }),
      }),
    );
  });

  describe('step A — planned due dates', () => {
    it('opens SCHEDULED_DUE when the planned date is inside the lead window', async () => {
      stub.rightsProfile.findMany.mockResolvedValueOnce([
        profile({ nextReviewAt: addDays(NOW, 10) }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: RightsRecheckReason.SCHEDULED_DUE }),
        }),
      );
    });

    it('does not open a task when the planned date is far away', async () => {
      stub.rightsProfile.findMany.mockResolvedValueOnce([
        profile({ nextReviewAt: addDays(NOW, 200) }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.create).not.toHaveBeenCalled();
    });

    it('skips a paused profile', async () => {
      stub.rightsProfile.findMany.mockResolvedValueOnce([
        profile({
          nextReviewAt: addDays(NOW, 1),
          recheckPolicy: RightsRecheckPolicy.PAUSED,
          recheckPausedUntil: addDays(NOW, 90),
        }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.create).not.toHaveBeenCalled();
    });

    it('excludes MANUAL_ONLY profiles at the query level', async () => {
      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ recheckPolicy: { not: 'MANUAL_ONLY' } }),
        }),
      );
    });
  });

  describe('step B — stale versions', () => {
    it('opens a task with the reason derived from the stale reason code', async () => {
      stub.bookVersion.findMany.mockResolvedValueOnce([
        version({ rightsStaleReasonCode: 'AUDIO_CHAPTER_CREATED' }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: RightsRecheckReason.AUDIO_ADDED,
            bookVersionId: 'v1',
            triggerCode: 'AUDIO_CHAPTER_CREATED',
          }),
        }),
      );
    });
  });

  /**
   * WP-D.3: черновик живёт в окне наполнения — его метки staleness обслуживает само окно,
   * а задача перепроверки на неопубликованный текст только добавляет просрочку
   * (`RIGHTS_RECHECK_OVERDUE` через 37 дней). Опубликованные версии сканируются как прежде.
   */
  describe('step B — draft fill window (WP-D.3)', () => {
    it('excludes drafts at the query level', async () => {
      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { not: 'draft' } }),
        }),
      );
    });

    it('still opens a task for a published stale version', async () => {
      stub.bookVersion.findMany.mockResolvedValueOnce([version({ status: 'published' })]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bookVersionId: 'v1' }) }),
      );
    });
  });

  describe('step C — stale reviews', () => {
    it('opens REVIEW_STALE for a review in STALE status', async () => {
      stub.rightsReview.findMany.mockResolvedValueOnce([
        {
          id: 'review-9',
          rightsProfileId: 'profile-1',
          status: 'STALE',
          approvedAt: null,
          nextReviewAt: null,
          previousReviewId: null,
          chainRootReviewId: 'review-9',
          revisionNumber: 1,
        },
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: RightsRecheckReason.REVIEW_STALE }),
        }),
      );
    });
  });

  describe('step D — reminders', () => {
    it('sends a reminder when the stage increases', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([task({ dueAt: addDays(NOW, 3) })]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RECHECK_DUE' }),
      );
      expect(stub.rightsRecheckEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: RightsRecheckEventType.REMINDER_SENT }),
        }),
      );
    });

    it('stays silent when the stage has not moved', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({ dueAt: addDays(NOW, 3), reminderStage: 'LEAD_7' as never }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('stays silent for a snoozed task', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({ dueAt: addDays(NOW, 3), snoozedUntil: addDays(NOW, 5) }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('step E — auto-close', () => {
    it('closes a task superseded by a newer approved review', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([task()]);
      stub.rightsReview.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          where['status'] === 'HUMAN_APPROVED' && where['approvedAt']
            ? Promise.resolve({ id: 'review-new', approvedAt: NOW })
            : Promise.resolve(null),
      );

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RightsRecheckStatus.COMPLETED,
            resolution: RightsRecheckResolution.SUPERSEDED_BY_NEW_REVIEW,
            completedReviewId: 'review-new',
          }),
        }),
      );
    });

    // WP-2.5 / R9-01: the version keeps pointing at the old review (R5-03), so closing the task on
    // the mere existence of a newer approved review reported a re-check that never reached the
    // published book — and shut the audit trail while it was at it.
    it('keeps a version task open while the version is still on the old review', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([task({ bookVersionId: 'v1' })]);
      stub.rightsReview.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          where['status'] === 'HUMAN_APPROVED' && where['approvedAt']
            ? Promise.resolve({ id: 'review-new', rightsProfileId: 'profile-2', approvedAt: NOW })
            : Promise.resolve(null),
      );
      stub.bookVersion.findUnique.mockResolvedValue(
        version({ approvedRightsReviewId: 'review-1' }),
      );

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolution: RightsRecheckResolution.SUPERSEDED_BY_NEW_REVIEW,
          }),
        }),
      );
    });

    it('closes a version task once the version was moved onto the newer review', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([task({ bookVersionId: 'v1' })]);
      stub.rightsReview.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          where['status'] === 'HUMAN_APPROVED' && where['approvedAt']
            ? Promise.resolve({ id: 'review-new', rightsProfileId: 'profile-2', approvedAt: NOW })
            : Promise.resolve(null),
      );
      stub.bookVersion.findUnique.mockResolvedValue(
        version({ approvedRightsReviewId: 'review-new', rightsProfileId: 'profile-2' }),
      );

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolution: RightsRecheckResolution.SUPERSEDED_BY_NEW_REVIEW,
            completedReviewId: 'review-new',
          }),
        }),
      );
    });

    it('closes a content task with CONTENT_REVERTED once the version is clean again', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({ reason: RightsRecheckReason.CONTENT_CHANGED, bookVersionId: 'v1' }),
      ]);
      stub.bookVersion.findUnique.mockResolvedValue(
        version({ rightsRecheckRequired: false, rightsStaleDetectedAt: null }),
      );

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolution: RightsRecheckResolution.CONTENT_REVERTED,
          }),
        }),
      );
    });
  });

  describe('step F — severity escalation', () => {
    it('raises severity and records SEVERITY_ESCALATED', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({ dueAt: addDays(NOW, -60), severity: RightsRecheckSeverity.INFO }),
      ]);

      await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null);

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { severity: RightsRecheckSeverity.BLOCKING },
        }),
      );
      expect(stub.rightsRecheckEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: RightsRecheckEventType.SEVERITY_ESCALATED }),
        }),
      );
    });
  });

  describe('concurrency and failures', () => {
    it('rejects a concurrent manual scan with RECHECK_SCAN_ALREADY_RUNNING', async () => {
      // Keep the first run in-flight while the second one starts. Queued rather than a single
      // reassigned callback: `claimRun`'s own claim transaction (lock, findFirst, create) adds
      // several microtask ticks ahead of the first `rightsProfile.findMany` call, so a `release`
      // captured too early — before that call has actually happened — would target nothing.
      let released = false;
      const pending: Array<() => void> = [];
      stub.rightsProfile.findMany.mockImplementation(
        () =>
          new Promise((resolve) => {
            if (released) resolve([]);
            else pending.push(() => resolve([]));
          }),
      );

      const first = scheduler.runScan(RightsRecheckTriggerSource.MANUAL, 'admin-1');
      await Promise.resolve();

      await expect(
        scheduler.runScan(RightsRecheckTriggerSource.MANUAL, 'admin-1'),
      ).rejects.toMatchObject({
        response: { code: 'RECHECK_SCAN_ALREADY_RUNNING', statusCode: 409 },
      });

      released = true;
      pending.splice(0).forEach((resolve) => resolve());
      await first;
    });

    // 🔴 LEGACY-021: this is the case `isRunning` never covered — a RUNNING row already claimed
    // by ANOTHER instance, discovered only through the DB, not through in-process state.
    it('rejects a manual scan when another instance already claimed a running row', async () => {
      const runningRow = { id: 'run-other-instance', startedAt: NOW };
      stub.rightsRecheckScanRun.findFirst.mockResolvedValueOnce(runningRow);

      await expect(
        scheduler.runScan(RightsRecheckTriggerSource.MANUAL, 'admin-1'),
      ).rejects.toMatchObject({
        response: { code: 'RECHECK_SCAN_ALREADY_RUNNING', statusCode: 409 },
      });
      expect(stub.rightsRecheckScanRun.create).not.toHaveBeenCalled();
    });

    it('skips an automatic scan when another instance already claimed a running row', async () => {
      const runningRow = { id: 'run-other-instance', startedAt: NOW };
      stub.rightsRecheckScanRun.findFirst.mockResolvedValueOnce(runningRow);

      const result = await scheduler.runScan(RightsRecheckTriggerSource.SCHEDULER, null);

      expect(result.id).toBe('run-other-instance');
      expect(stub.rightsRecheckScanRun.create).not.toHaveBeenCalled();
    });

    it('reclaims the slot when the running row is older than the stale ceiling', async () => {
      const abandonedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000); // 2h ago, default ceiling is 1h
      const runningRow = { id: 'run-abandoned', startedAt: abandonedAt };
      stub.rightsRecheckScanRun.findFirst.mockResolvedValueOnce(runningRow);

      const result = await scheduler.runScan(RightsRecheckTriggerSource.MANUAL, 'admin-1');

      expect(stub.rightsRecheckScanRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-abandoned' },
          data: expect.objectContaining({ status: RightsRecheckScanStatus.FAILED }),
        }),
      );
      expect(stub.rightsRecheckScanRun.create).toHaveBeenCalled();
      expect(result.status).toBe(RightsRecheckScanStatus.SUCCEEDED);
    });

    /**
     * 🔴 Обратная сторона реклейма: скан, идущий дольше потолка, сосед объявляет брошенным
     * и штампует его строку `FAILED`. Безусловная запись вердикта в конце перевернула бы её
     * обратно в `SUCCEEDED` с настоящими счётчиками — админу показали бы успешный прогон ровно
     * на той строке, которую объявили брошенной, и от факта перехвата не осталось бы следа.
     */
    it('does not overwrite the verdict when another instance reclaimed the slot', async () => {
      // Слот перехвачен: guarded-запись `status: RUNNING` больше не находит строку.
      stub.rightsRecheckScanRun.updateMany.mockResolvedValue({ count: 0 });
      stub.rightsRecheckScanRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: RightsRecheckScanStatus.FAILED,
        source: RightsRecheckTriggerSource.SCHEDULER,
        startedAt: NOW,
        finishedAt: NOW,
        durationMs: 1,
        profilesScanned: 0,
        versionsScanned: 0,
        tasksCreated: 0,
        tasksEscalated: 0,
        tasksAutoClosed: 0,
        remindersSent: 0,
        errorMessage: 'Abandoned: ran for more than the 3600000ms ceiling without finishing',
        triggeredByUserId: null,
      });

      const result = await scheduler.runScan(RightsRecheckTriggerSource.SCHEDULER, null);

      // Отдаётся то, что реально лежит в базе, — перехват, а не выдуманный успех.
      expect(result.status).toBe(RightsRecheckScanStatus.FAILED);
      expect(result.errorMessage).toContain('Abandoned');
      // И ни одной записи мимо условия `status: RUNNING`.
      const unguarded = stub.rightsRecheckScanRun.updateMany.mock.calls.filter(
        ([args]: [{ where?: Record<string, unknown> }]) =>
          args?.where?.status !== RightsRecheckScanStatus.RUNNING,
      );
      expect(unguarded).toHaveLength(0);
    });

    it('reports the running row, not the previous finished one, on the in-process skip', async () => {
      // Первый прогон держит флаг; второй уходит в быстрый short-circuit.
      const release: () => void = () => undefined;
      let released = false;
      const pending: Array<() => void> = [];
      stub.rightsProfile.findMany.mockImplementation(
        () =>
          new Promise((resolve) => {
            if (released) resolve([]);
            else pending.push(() => resolve([]));
          }),
      );

      const first = scheduler.runScan(RightsRecheckTriggerSource.SCHEDULER, null);
      await Promise.resolve();

      await scheduler.runScan(RightsRecheckTriggerSource.SCHEDULER, null);

      // Запрос идущего прогона фильтруется по RUNNING, иначе вернулся бы прошлый, уже
      // закрытый прогон — и вызывающий принял бы его за текущий.
      expect(stub.rightsRecheckScanRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: RightsRecheckScanStatus.RUNNING }),
        }),
      );

      released = true;
      pending.splice(0).forEach((resolve) => resolve());
      void release;
      await first;
    });

    it('records FAILED and swallows the error for an automatic run', async () => {
      stub.rightsProfile.findMany.mockRejectedValue(new Error('database down'));

      const result = await scheduler.runScan(RightsRecheckTriggerSource.SCHEDULER, null);

      expect(result.status).toBe(RightsRecheckScanStatus.FAILED);
      expect(stub.rightsRecheckScanRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: RightsRecheckScanStatus.RUNNING }),
          data: expect.objectContaining({
            status: RightsRecheckScanStatus.FAILED,
            errorMessage: 'database down',
          }),
        }),
      );
    });

    it('rethrows for a manual run', async () => {
      stub.rightsProfile.findMany.mockRejectedValue(new Error('database down'));

      await expect(scheduler.runScan(RightsRecheckTriggerSource.MANUAL, 'admin-1')).rejects.toThrow(
        'database down',
      );
    });
  });

  describe('onModuleInit', () => {
    it('does not start a timer when the scheduler is disabled', () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      build(configWith({ RIGHTS_RECHECK_SCHEDULER_ENABLED: '0' }));

      scheduler.onModuleInit();

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
    });
  });
});
