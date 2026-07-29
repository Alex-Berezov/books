import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from './rights-notifications.service';
import {
  RightsNotificationSeverity,
  RightsNotificationType,
  type RightsNotificationRecord,
} from './rights-agent-interface';

const NOW = new Date('2026-07-29T12:00:00.000Z');

const createNotification = (
  overrides: Partial<RightsNotificationRecord> = {},
): RightsNotificationRecord => ({
  id: 'notification-1',
  type: RightsNotificationType.AGENT_REPORT_RECEIVED,
  severity: RightsNotificationSeverity.SUCCESS,
  titleRu: 'Получен отчёт агента',
  messageRu: 'Внешний агент прислал отчёт.',
  targetUserId: null,
  rightsIntakeId: 'intake-1',
  agentSubmissionId: 'submission-1',
  rightsReviewImportId: null,
  rightsProfileId: null,
  bookVersionId: null,
  payload: null,
  isRead: false,
  readAt: null,
  readByUserId: null,
  createdAt: NOW,
  ...overrides,
});

interface PrismaStub {
  rightsNotification: Record<string, jest.Mock>;
}

const createPrismaStub = (): PrismaStub => ({
  rightsNotification: {
    findMany: jest.fn().mockResolvedValue([createNotification()]),
    findUnique: jest.fn().mockResolvedValue(createNotification()),
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: Partial<RightsNotificationRecord> }) =>
        createNotification(data),
      ),
    update: jest
      .fn()
      .mockImplementation(({ data }: { data: Partial<RightsNotificationRecord> }) =>
        createNotification({ ...data, isRead: true }),
      ),
    updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    count: jest.fn().mockResolvedValue(1),
  },
});

describe('RightsNotificationsService', () => {
  let prisma: PrismaStub;
  let service: RightsNotificationsService;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new RightsNotificationsService(prisma as unknown as PrismaService);
  });

  it('creates a notification with the requested type, severity and links', async () => {
    await service.create({
      type: RightsNotificationType.AGENT_TOKEN_ISSUED,
      severity: RightsNotificationSeverity.INFO,
      titleRu: 'Выпущен токен для агента',
      messageRu: 'Токен выпущен',
      targetUserId: 'user-1',
      rightsIntakeId: 'intake-1',
    });

    expect(prisma.rightsNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: RightsNotificationType.AGENT_TOKEN_ISSUED,
        severity: RightsNotificationSeverity.INFO,
        targetUserId: 'user-1',
        rightsIntakeId: 'intake-1',
      }),
    });
  });

  it('defaults severity to INFO', async () => {
    await service.create({
      type: RightsNotificationType.OTHER,
      titleRu: 'Заголовок',
      messageRu: 'Сообщение',
    });

    expect(prisma.rightsNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ severity: RightsNotificationSeverity.INFO }),
    });
  });

  it('lists broadcasts and own notifications, never someone else’s', async () => {
    await service.list('user-1', {});

    const where = prisma.rightsNotification.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where['OR']).toEqual([{ targetUserId: null }, { targetUserId: 'user-1' }]);
  });

  it('applies the unreadOnly, type and severity filters', async () => {
    await service.list('user-1', {
      unreadOnly: true,
      type: RightsNotificationType.HUMAN_REVIEW_REQUIRED,
      severity: RightsNotificationSeverity.WARNING,
    });

    const where = prisma.rightsNotification.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where['isRead']).toBe(false);
    expect(where['type']).toBe(RightsNotificationType.HUMAN_REVIEW_REQUIRED);
    expect(where['severity']).toBe(RightsNotificationSeverity.WARNING);
  });

  it('counts unread notifications visible to the user', async () => {
    prisma.rightsNotification.count.mockResolvedValue(7);

    const result = await service.unreadCount('user-1');

    expect(result).toEqual({ unreadCount: 7 });
    expect(prisma.rightsNotification.count).toHaveBeenCalledWith({
      where: {
        OR: [{ targetUserId: null }, { targetUserId: 'user-1' }],
        isRead: false,
      },
    });
  });

  it('rejects markRead for a notification addressed to another user', async () => {
    prisma.rightsNotification.findUnique.mockResolvedValue(
      createNotification({ targetUserId: 'user-2' }),
    );

    await expect(service.markRead('notification-1', 'user-1')).rejects.toThrow(HttpException);
    expect(prisma.rightsNotification.update).not.toHaveBeenCalled();
  });

  it('is idempotent: marking an already read notification does not move readAt', async () => {
    const readAt = new Date('2026-07-29T09:00:00.000Z');
    prisma.rightsNotification.findUnique.mockResolvedValue(
      createNotification({ isRead: true, readAt, readByUserId: 'user-1' }),
    );

    const result = await service.markRead('notification-1', 'user-1');

    expect(prisma.rightsNotification.update).not.toHaveBeenCalled();
    expect(result.readAt).toBe(readAt.toISOString());
  });

  it('markAllRead returns the number of updated rows', async () => {
    const result = await service.markAllRead('user-1');

    expect(result).toEqual({ updated: 3 });
    expect(prisma.rightsNotification.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ targetUserId: null }, { targetUserId: 'user-1' }], isRead: false },
      data: expect.objectContaining({ isRead: true, readByUserId: 'user-1' }),
    });
  });

  it('exposes no deletion path — notifications are permanent', () => {
    expect((service as unknown as Record<string, unknown>)['delete']).toBeUndefined();
    expect((service as unknown as Record<string, unknown>)['remove']).toBeUndefined();
  });
});
