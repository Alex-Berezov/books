import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import { RightsLegalChangeService } from './rights-legal-change.service';
import { RightsRecheckService } from './rights-recheck.service';
import {
  RightsLegalChangeStatus,
  RightsLegalChangeType,
  RightsRecheckReason,
  RightsRecheckSeverity,
  type RightsLegalChangeEventRecord,
} from './rights-recheck-interface';

const NOW = new Date();

const event = (
  overrides: Partial<RightsLegalChangeEventRecord> = {},
): RightsLegalChangeEventRecord => ({
  id: 'lc-1',
  titleRu: 'Продление срока охраны в ЕС',
  descriptionRu: 'Описание изменения',
  changeType: RightsLegalChangeType.COPYRIGHT_TERM_CHANGE,
  status: RightsLegalChangeStatus.DRAFT,
  severity: RightsRecheckSeverity.WARNING,
  jurisdictionCodes: ['DE', 'FR'],
  appliesToAllCountries: false,
  effectiveFrom: null,
  sourceUrl: null,
  sourceTitle: null,
  appliedAt: null,
  appliedByUserId: null,
  affectedProfilesCount: 0,
  createdTasksCount: 0,
  archivedAt: null,
  createdByUserId: 'u1',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const profile = (id: string) => ({
  id,
  rightsIntakeId: `intake-${id}`,
  status: 'APPROVED',
  isCurrent: true,
  nextReviewAt: null,
  recheckPolicy: 'INHERIT_REPORT',
  recheckIntervalDays: null,
  recheckPausedUntil: null,
  recheckPauseReasonRu: null,
  lastRecheckScanAt: null,
  createdAt: NOW,
});

interface Stub {
  rightsLegalChangeEvent: Record<string, jest.Mock>;
  rightsRecheckTask: Record<string, jest.Mock>;
  rightsRecheckEvent: Record<string, jest.Mock>;
  rightsRecheckScanRun: Record<string, jest.Mock>;
  rightsProfile: Record<string, jest.Mock>;
  rightsReview: Record<string, jest.Mock>;
  bookVersion: Record<string, jest.Mock>;
  rightsIntake: Record<string, jest.Mock>;
  territoryDecision: Record<string, jest.Mock>;
  $transaction: jest.Mock;
}

const createStub = (): Stub => {
  const stub: Stub = {
    rightsLegalChangeEvent: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(event(data as Partial<RightsLegalChangeEventRecord>)),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(event(data as Partial<RightsLegalChangeEventRecord>)),
        ),
      findUnique: jest.fn().mockResolvedValue(event()),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsRecheckTask: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'task-x' }),
      update: jest.fn().mockResolvedValue({ id: 'task-x' }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsRecheckEvent: { create: jest.fn().mockResolvedValue({}) },
    rightsRecheckScanRun: {},
    rightsProfile: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(profile(where.id)),
        ),
      update: jest.fn().mockResolvedValue({}),
    },
    rightsReview: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    bookVersion: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
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
  stub.$transaction.mockImplementation((callback: (client: Stub) => Promise<unknown>) =>
    callback(stub),
  );
  return stub;
};

describe('RightsLegalChangeService', () => {
  let stub: Stub;
  let notifications: { create: jest.Mock };
  let service: RightsLegalChangeService;

  beforeEach(() => {
    stub = createStub();
    notifications = { create: jest.fn().mockResolvedValue({}) };
    const recheckService = new RightsRecheckService(
      stub as unknown as PrismaService,
      notifications as unknown as RightsNotificationsService,
      { get: () => undefined } as unknown as ConfigService,
    );
    service = new RightsLegalChangeService(
      stub as unknown as PrismaService,
      recheckService,
      notifications as unknown as RightsNotificationsService,
    );
  });

  it('creates the event in DRAFT status', async () => {
    const result = await service.create(
      {
        titleRu: 'Продление срока охраны в ЕС',
        descriptionRu: 'Описание изменения',
        changeType: RightsLegalChangeType.COPYRIGHT_TERM_CHANGE,
        jurisdictionCodes: ['DE', 'FR'],
      },
      'u1',
    );

    expect(result.status).toBe(RightsLegalChangeStatus.DRAFT);
    expect(stub.rightsLegalChangeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RightsLegalChangeStatus.DRAFT }),
      }),
    );
  });

  it('rejects malformed jurisdiction codes', async () => {
    await expect(
      service.create(
        {
          titleRu: 'Заголовок',
          descriptionRu: 'Описание',
          changeType: RightsLegalChangeType.OTHER,
          jurisdictionCodes: ['DEU'],
        },
        'u1',
      ),
    ).rejects.toMatchObject({
      response: { code: 'LEGAL_CHANGE_INVALID_JURISDICTION', statusCode: 400 },
    });
  });

  it('rejects an empty jurisdiction list when the change is not global', async () => {
    await expect(
      service.create(
        {
          titleRu: 'Заголовок',
          descriptionRu: 'Описание',
          changeType: RightsLegalChangeType.OTHER,
          jurisdictionCodes: [],
        },
        'u1',
      ),
    ).rejects.toMatchObject({
      response: { code: 'LEGAL_CHANGE_INVALID_JURISDICTION', statusCode: 400 },
    });
  });

  it('refuses to edit an event that is not a DRAFT', async () => {
    stub.rightsLegalChangeEvent.findUnique.mockResolvedValue(
      event({ status: RightsLegalChangeStatus.APPLIED }),
    );

    await expect(service.update('lc-1', { titleRu: 'Новый' }, 'u1')).rejects.toMatchObject({
      response: { code: 'LEGAL_CHANGE_NOT_EDITABLE', statusCode: 409 },
    });
  });

  describe('apply', () => {
    it('opens tasks only for profiles with a decision in the affected jurisdictions', async () => {
      stub.rightsProfile.findMany.mockResolvedValue([profile('p1'), profile('p2')]);
      stub.territoryDecision.findMany.mockResolvedValue([
        { rightsProfileId: 'p1', countryCode: 'DE', finalStatus: 'ALLOWED' },
      ]);

      await service.apply('lc-1', 'admin-1');

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledTimes(1);
      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: RightsRecheckReason.LEGAL_CHANGE,
            rightsProfileId: 'p1',
            legalChangeEventId: 'lc-1',
          }),
        }),
      );
    });

    it('captures every current profile when appliesToAllCountries is set', async () => {
      stub.rightsLegalChangeEvent.findUnique.mockResolvedValue(
        event({ appliesToAllCountries: true, jurisdictionCodes: [] }),
      );
      stub.rightsProfile.findMany.mockResolvedValue([profile('p1'), profile('p2')]);

      await service.apply('lc-1', 'admin-1');

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledTimes(2);
      expect(stub.territoryDecision.findMany).not.toHaveBeenCalled();
    });

    it('sends exactly one summary notification, not one per profile', async () => {
      stub.rightsProfile.findMany.mockResolvedValue([profile('p1'), profile('p2'), profile('p3')]);
      stub.territoryDecision.findMany.mockResolvedValue([
        { rightsProfileId: 'p1', countryCode: 'DE', finalStatus: 'ALLOWED' },
        { rightsProfileId: 'p2', countryCode: 'FR', finalStatus: 'BLOCKED' },
        { rightsProfileId: 'p3', countryCode: 'DE', finalStatus: 'ALLOWED' },
      ]);

      await service.apply('lc-1', 'admin-1');

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LEGAL_CHANGE_APPLIED' }),
      );
    });

    it('refuses to apply an event that is not a DRAFT', async () => {
      stub.rightsLegalChangeEvent.findUnique.mockResolvedValue(
        event({ status: RightsLegalChangeStatus.APPLIED }),
      );

      await expect(service.apply('lc-1', 'admin-1')).rejects.toMatchObject({
        response: { code: 'LEGAL_CHANGE_ALREADY_APPLIED', statusCode: 409 },
      });
    });

    it('uses effectiveFrom as the deadline when it lies in the future', async () => {
      const effectiveFrom = new Date(NOW.getTime() + 90 * 86_400_000);
      stub.rightsLegalChangeEvent.findUnique.mockResolvedValue(event({ effectiveFrom }));
      stub.rightsProfile.findMany.mockResolvedValue([profile('p1')]);
      stub.territoryDecision.findMany.mockResolvedValue([
        { rightsProfileId: 'p1', countryCode: 'DE', finalStatus: 'ALLOWED' },
      ]);

      await service.apply('lc-1', 'admin-1');

      expect(stub.rightsRecheckTask.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ dueAt: effectiveFrom }) }),
      );
    });
  });

  it('archive does not close the tasks the event opened', async () => {
    await service.archive('lc-1', 'admin-1');

    expect(stub.rightsLegalChangeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RightsLegalChangeStatus.ARCHIVED }),
      }),
    );
    expect(stub.rightsRecheckTask.update).not.toHaveBeenCalled();
  });
});
