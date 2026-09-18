import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import { RightsRecheckService } from './rights-recheck.service';
import {
  RightsRecheckEventType,
  RightsRecheckPolicy,
  RightsRecheckReason,
  RightsRecheckResolution,
  RightsRecheckSeverity,
  RightsRecheckStatus,
  RightsRecheckTriggerSource,
  type RightsRecheckTaskRecord,
} from './rights-recheck-interface';
import { addDays } from './rights-recheck.util';
import { RECHECK_OPEN_STATUSES } from './rights-recheck.constants';

const NOW = new Date();

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
  events: [],
  ...overrides,
});

interface Stub {
  rightsRecheckTask: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  rightsRecheckEvent: { create: jest.Mock; findMany: jest.Mock };
  rightsLegalChangeEvent: Record<string, jest.Mock>;
  rightsRecheckScanRun: Record<string, jest.Mock>;
  rightsProfile: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  rightsReview: { findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  bookVersion: { findUnique: jest.Mock; findMany: jest.Mock };
  rightsIntake: { findUnique: jest.Mock };
  territoryDecision: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

const createStub = (): Stub => {
  const stub: Stub = {
    rightsRecheckTask: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(
            task({ id: 'created-task', ...(data as Partial<RightsRecheckTaskRecord>) }),
          ),
        ),
      update: jest.fn().mockResolvedValue(task()),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsRecheckEvent: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
    rightsLegalChangeEvent: {},
    rightsRecheckScanRun: {},
    rightsProfile: {
      findUnique: jest.fn().mockResolvedValue({
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
      }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    rightsReview: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    bookVersion: {
      findUnique: jest.fn().mockResolvedValue({ id: 'v1', rightsProfileId: 'profile-1' }),
      findMany: jest.fn().mockResolvedValue([]),
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
  };
  // The transaction client is the stub itself — every delegate is already a mock.
  stub.$transaction.mockImplementation((callback: (client: Stub) => Promise<unknown>) =>
    callback(stub),
  );
  return stub;
};

const configWith = (values: Record<string, string> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('RightsRecheckService', () => {
  let stub: Stub;
  let notifications: { create: jest.Mock };
  let service: RightsRecheckService;

  beforeEach(() => {
    stub = createStub();
    notifications = { create: jest.fn().mockResolvedValue({}) };
    service = new RightsRecheckService(
      stub as unknown as PrismaService,
      notifications as unknown as RightsNotificationsService,
      configWith(),
    );
  });

  describe('list', () => {
    const openStatuses = { in: [...RECHECK_OPEN_STATUSES] };

    const whereOfListQuery = (): Record<string, unknown> =>
      (stub.rightsRecheckTask.findMany.mock.calls[0][0] as { where: Record<string, unknown> })
        .where;

    it('combines an explicit status with overdueOnly via AND instead of overwriting it (LEGACY-406)', async () => {
      const before = Date.now();
      await service.list({
        page: 1,
        limit: 20,
        status: RightsRecheckStatus.COMPLETED,
        overdueOnly: true,
      });

      expect(stub.rightsRecheckTask.findMany).toHaveBeenCalledTimes(1);
      // Тело целиком: и явный статус, и условие ветки `overdueOnly` со сроком - возврат
      // перезаписи убирает `status` сверху, потеря `dueAt` убирает его из ветки.
      const where = whereOfListQuery();
      expect(where).toEqual({
        status: RightsRecheckStatus.COMPLETED,
        AND: [{ status: openStatuses, dueAt: { lt: expect.any(Date) } }],
      });
      // Граница - именно «сейчас»: сдвиг `lt` вперёд пустил бы в «просроченные» задачи,
      // срок которых ещё не наступил.
      const [branch] = where['AND'] as [{ dueAt: { lt: Date } }];
      expect(branch.dueAt.lt.getTime()).toBeGreaterThanOrEqual(before);
      expect(branch.dueAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('combines an explicit status with dueWithinDays via AND instead of overwriting it (LEGACY-406)', async () => {
      await service.list({
        page: 1,
        limit: 20,
        status: RightsRecheckStatus.COMPLETED,
        dueWithinDays: 5,
      });

      expect(stub.rightsRecheckTask.findMany).toHaveBeenCalledTimes(1);
      expect(whereOfListQuery()).toEqual({
        status: RightsRecheckStatus.COMPLETED,
        AND: [{ status: openStatuses, dueAt: { lte: expect.any(Date) } }],
      });
    });

    it('applies overdueOnly and dueWithinDays as two independent AND branches, not an else-if chain (LEGACY-406)', async () => {
      await service.list({ page: 1, limit: 20, overdueOnly: true, dueWithinDays: 5 });

      expect(stub.rightsRecheckTask.findMany).toHaveBeenCalledTimes(1);
      // Возврат `else if` оставит одну ветку из двух.
      expect(whereOfListQuery()).toEqual({
        AND: [
          { status: openStatuses, dueAt: { lt: expect.any(Date) } },
          { status: openStatuses, dueAt: { lte: expect.any(Date) } },
        ],
      });
    });

    it('applies dueWithinDays on its own, with the window measured from now (LEGACY-406)', async () => {
      const before = Date.now();
      await service.list({ page: 1, limit: 20, dueWithinDays: 5 });

      expect(stub.rightsRecheckTask.findMany).toHaveBeenCalledTimes(1);
      const where = whereOfListQuery();
      expect(where).toEqual({
        AND: [{ status: openStatuses, dueAt: { lte: expect.any(Date) } }],
      });
      const [branch] = where['AND'] as [{ dueAt: { lte: Date } }];
      // Окно именно вперёд на пять суток, а не назад и не «сегодня».
      expect(branch.dueAt.lte.getTime()).toBeGreaterThanOrEqual(before + 5 * 24 * 60 * 60 * 1000);
      expect(branch.dueAt.lte.getTime()).toBeLessThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    });
  });

  describe('ensureTask', () => {
    it('creates the task, a TASK_CREATED event and a RECHECK_TASK_OPENED notification', async () => {
      const result = await service.ensureTask({
        reason: RightsRecheckReason.SCHEDULED_DUE,
        source: RightsRecheckTriggerSource.SCHEDULER,
        rightsProfileId: 'profile-1',
        rightsIntakeId: 'intake-1',
        dueAt: addDays(NOW, 10),
        titleRu: 'Плановая перепроверка прав',
        descriptionRu: 'Описание',
      });

      expect(result.created).toBe(true);
      expect(stub.rightsRecheckTask.create).toHaveBeenCalledTimes(1);
      expect(stub.rightsRecheckEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: RightsRecheckEventType.TASK_CREATED }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RECHECK_TASK_OPENED' }),
        expect.anything(),
      );
    });

    it('is idempotent for the same (profile, reason) pair', async () => {
      stub.rightsRecheckTask.findFirst.mockResolvedValue(task());

      const result = await service.ensureTask({
        reason: RightsRecheckReason.SCHEDULED_DUE,
        source: RightsRecheckTriggerSource.SCHEDULER,
        rightsProfileId: 'profile-1',
        dueAt: addDays(NOW, 10),
        titleRu: 'Плановая перепроверка прав',
        descriptionRu: 'Описание',
      });

      expect(result.created).toBe(false);
      expect(stub.rightsRecheckTask.create).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('pulls the deadline forward and records DUE_DATE_CHANGED', async () => {
      const existing = task({ dueAt: addDays(NOW, 30) });
      stub.rightsRecheckTask.findFirst.mockResolvedValue(existing);

      const earlier = addDays(NOW, 3);
      const result = await service.ensureTask({
        reason: RightsRecheckReason.SCHEDULED_DUE,
        source: RightsRecheckTriggerSource.SCHEDULER,
        rightsProfileId: 'profile-1',
        dueAt: earlier,
        titleRu: 'Плановая перепроверка прав',
        descriptionRu: 'Описание',
      });

      expect(result.created).toBe(false);
      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith({
        where: { id: existing.id },
        data: { dueAt: earlier },
      });
      expect(stub.rightsRecheckEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: RightsRecheckEventType.DUE_DATE_CHANGED }),
        }),
      );
    });

    /**
     * LEGACY-036. Перенос срока существующей задачи шёл клиентом `tx ?? this.getDatabase()`,
     * и своей транзакции не открывал ни один из шести вызывающих `ensureTask` — то есть срок
     * и запись о его переносе всегда писались двумя независимыми `await`. Ветка создания задачи
     * ниже транзакцию открывала, эта — нет.
     *
     * Двойник фиксирует записи транзакции только после успеха коллбэка: запись мимо транзакции
     * считается закоммиченной сразу, и тест краснеет.
     */
    it('перенос срока: отказ журнала откатывает и сам перенос', async () => {
      const existing = task({ dueAt: addDays(NOW, 30) });
      const committed: string[] = [];

      const clientFor = (buffer: string[]): Stub =>
        ({
          ...stub,
          rightsRecheckTask: {
            ...stub.rightsRecheckTask,
            findFirst: jest.fn().mockResolvedValue(existing),
            update: jest.fn(() => {
              buffer.push('task.update');
              return Promise.resolve(existing);
            }),
          },
          rightsRecheckEvent: {
            ...stub.rightsRecheckEvent,
            create: jest.fn(() => {
              throw new Error('journal write failed');
            }),
          },
        }) as unknown as Stub;

      const root = clientFor(committed);
      const client = {
        ...root,
        $transaction: async <T>(callback: (tx: Stub) => Promise<T>): Promise<T> => {
          const pending: string[] = [];
          const result = await callback(clientFor(pending));
          committed.push(...pending);
          return result;
        },
      };

      const atomicService = new RightsRecheckService(
        client as unknown as PrismaService,
        notifications as unknown as RightsNotificationsService,
        configWith(),
      );

      await expect(
        atomicService.ensureTask({
          reason: RightsRecheckReason.SCHEDULED_DUE,
          source: RightsRecheckTriggerSource.SCHEDULER,
          rightsProfileId: 'profile-1',
          dueAt: addDays(NOW, 3),
          titleRu: 'Плановая перепроверка прав',
          descriptionRu: 'Описание',
        }),
      ).rejects.toThrow('journal write failed');

      expect(committed).toHaveLength(0);
    });

    it('deduplicates version-scoped reasons by bookVersionId', async () => {
      await service.ensureTask({
        reason: RightsRecheckReason.CONTENT_CHANGED,
        source: RightsRecheckTriggerSource.CONTENT_HASH,
        rightsProfileId: 'profile-1',
        bookVersionId: 'v-42',
        dueAt: addDays(NOW, 7),
        titleRu: 'Контент изменился',
        descriptionRu: 'Описание',
      });

      expect(stub.rightsRecheckTask.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ bookVersionId: 'v-42' }),
        }),
      );
    });

    it('suppresses the notification when asked to', async () => {
      await service.ensureTask({
        reason: RightsRecheckReason.LEGAL_CHANGE,
        source: RightsRecheckTriggerSource.LEGAL_CHANGE,
        rightsProfileId: 'profile-1',
        legalChangeEventId: 'lc-1',
        dueAt: addDays(NOW, 14),
        titleRu: 'Изменение законодательства',
        descriptionRu: 'Описание',
        suppressNotification: true,
      });

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle transitions', () => {
    it('start moves PENDING to IN_PROGRESS', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(task());

      await service.start('task-1', 'user-1');

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: RightsRecheckStatus.IN_PROGRESS }),
        }),
      );
    });

    it('start on a closed task fails with RECHECK_TASK_ALREADY_CLOSED', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(
        task({ status: RightsRecheckStatus.COMPLETED }),
      );

      await expect(service.start('task-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'RECHECK_TASK_ALREADY_CLOSED', statusCode: 409 },
      });
    });

    it('start on an IN_PROGRESS task fails with RECHECK_TASK_INVALID_TRANSITION', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(
        task({ status: RightsRecheckStatus.IN_PROGRESS }),
      );

      await expect(service.start('task-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'RECHECK_TASK_INVALID_TRANSITION', statusCode: 409 },
      });
    });

    it('complete closes the task, records the event and notifies', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(task());

      await service.complete(
        'task-1',
        { resolution: RightsRecheckResolution.NO_CHANGE_NEEDED },
        'u1',
      );

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RightsRecheckStatus.COMPLETED,
            resolution: RightsRecheckResolution.NO_CHANGE_NEEDED,
          }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RECHECK_COMPLETED' }),
        expect.anything(),
      );
    });

    it('complete with an unknown completedReviewId fails with RECHECK_REVIEW_NOT_FOUND', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(task());
      stub.rightsReview.findUnique.mockResolvedValue(null);

      await expect(
        service.complete('task-1', { completedReviewId: 'missing-review' }, 'u1'),
      ).rejects.toMatchObject({
        response: { code: 'RECHECK_REVIEW_NOT_FOUND', statusCode: 404 },
      });
    });

    it('dismiss stores the reason and the DISMISSED_NOT_APPLICABLE resolution', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(task());

      await service.dismiss('task-1', { reasonRu: 'Не относится к этой книге' }, 'u1');

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RightsRecheckStatus.DISMISSED,
            dismissReasonRu: 'Не относится к этой книге',
            resolution: RightsRecheckResolution.DISMISSED_NOT_APPLICABLE,
          }),
        }),
      );
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('reopen brings a DISMISSED task back to PENDING with a REOPENED event', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(
        task({ status: RightsRecheckStatus.DISMISSED }),
      );

      await service.reopen('task-1', 'admin-1');

      expect(stub.rightsRecheckTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: RightsRecheckStatus.PENDING, resolution: null }),
        }),
      );
      expect(stub.rightsRecheckEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: RightsRecheckEventType.REOPENED }),
        }),
      );
    });

    it('snooze rejects a date in the past and one beyond the maximum', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(task());

      await expect(
        service.snooze('task-1', { until: addDays(NOW, -1).toISOString() }, 'u1'),
      ).rejects.toMatchObject({
        response: { code: 'RECHECK_INVALID_SNOOZE_DATE', statusCode: 400 },
      });

      await expect(
        service.snooze('task-1', { until: addDays(NOW, 400).toISOString() }, 'u1'),
      ).rejects.toMatchObject({
        response: { code: 'RECHECK_INVALID_SNOOZE_DATE', statusCode: 400 },
      });
    });

    it('has no delete method — tasks and events are never removed', () => {
      const candidate = service as unknown as Record<string, unknown>;
      expect(candidate['delete']).toBeUndefined();
      expect(candidate['remove']).toBeUndefined();
    });
  });

  describe('schedule', () => {
    it('rejects an out-of-range interval through the profile lookup path', async () => {
      stub.rightsProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.updateSchedule('missing-profile', { recheckIntervalDays: 30 }, 'u1'),
      ).rejects.toMatchObject({ response: { code: 'RECHECK_PROFILE_NOT_FOUND', statusCode: 404 } });
    });

    it('persists the policy and returns the recomputed due date', async () => {
      const nextReviewAt = addDays(NOW, 200);
      stub.rightsProfile.findUnique.mockResolvedValue({
        id: 'profile-1',
        rightsIntakeId: 'intake-1',
        status: 'APPROVED',
        isCurrent: true,
        nextReviewAt,
        recheckPolicy: RightsRecheckPolicy.INHERIT_REPORT,
        recheckIntervalDays: null,
        recheckPausedUntil: null,
        recheckPauseReasonRu: null,
        lastRecheckScanAt: null,
        createdAt: NOW,
      });

      const result = await service.updateSchedule(
        'profile-1',
        { recheckPolicy: RightsRecheckPolicy.INHERIT_REPORT },
        'u1',
      );

      expect(stub.rightsProfile.update).toHaveBeenCalled();
      expect(result.computedDueAt).toBe(nextReviewAt.toISOString());
    });
  });

  describe('createManual', () => {
    it('requires at least one target', async () => {
      await expect(
        service.createManual({ titleRu: 'Проверить', descriptionRu: 'Причина' }, 'u1'),
      ).rejects.toMatchObject({ response: { code: 'RECHECK_TARGET_REQUIRED', statusCode: 400 } });
    });

    it('never claims the scheduler-owned SCHEDULED_DUE reason', async () => {
      stub.rightsRecheckTask.findUnique.mockResolvedValue(task());

      await service.createManual(
        {
          reason: RightsRecheckReason.SCHEDULED_DUE,
          rightsProfileId: 'profile-1',
          titleRu: 'Проверить',
          descriptionRu: 'Причина',
        },
        'u1',
      );

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: RightsRecheckReason.MANUAL_REQUEST }),
        }),
      );
    });
  });

  describe('evaluateVersionRecheck', () => {
    it('produces a RIGHTS_RECHECK_OVERDUE blocker for a BLOCKING task', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({ dueAt: addDays(NOW, -60), severity: RightsRecheckSeverity.BLOCKING }),
      ]);

      const result = await service.evaluateVersionRecheck('v1');

      expect(result.blockers.map((b) => b.code)).toContain('RIGHTS_RECHECK_OVERDUE');
      expect(result.blockingTasksCount).toBe(1);
      expect(result.overdueTasksCount).toBe(1);
    });

    it('downgrades the blocker to a warning when blocking is disabled', async () => {
      service = new RightsRecheckService(
        stub as unknown as PrismaService,
        notifications as unknown as RightsNotificationsService,
        configWith({ RIGHTS_RECHECK_BLOCK_PUBLISH_ON_OVERDUE: '0' }),
      );
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({ dueAt: addDays(NOW, -60), severity: RightsRecheckSeverity.BLOCKING }),
      ]);

      const result = await service.evaluateVersionRecheck('v1');

      expect(result.blockers).toHaveLength(0);
      expect(result.warnings.map((w) => w.code)).toContain('RIGHTS_RECHECK_OVERDUE');
    });

    it('never blocks on a snoozed task', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({
          dueAt: addDays(NOW, -60),
          severity: RightsRecheckSeverity.BLOCKING,
          snoozedUntil: addDays(NOW, 5),
        }),
      ]);

      const result = await service.evaluateVersionRecheck('v1');

      expect(result.blockers).toHaveLength(0);
      expect(result.warnings.map((w) => w.code)).toContain('RIGHTS_RECHECK_TASK_SNOOZED');
    });

    it('blocks on a BLOCKING legal-change task with its own code', async () => {
      stub.rightsRecheckTask.findMany.mockResolvedValue([
        task({
          reason: RightsRecheckReason.LEGAL_CHANGE,
          severity: RightsRecheckSeverity.BLOCKING,
          legalChangeEventId: 'lc-1',
          dueAt: addDays(NOW, 10),
        }),
      ]);

      const result = await service.evaluateVersionRecheck('v1');

      expect(result.blockers.map((b) => b.code)).toContain('RIGHTS_RECHECK_LEGAL_CHANGE_PENDING');
    });

    it('fails with RECHECK_VERSION_NOT_FOUND for an unknown version', async () => {
      stub.bookVersion.findUnique.mockResolvedValue(null);

      await expect(service.evaluateVersionRecheck('missing')).rejects.toBeInstanceOf(HttpException);
    });
  });
});
