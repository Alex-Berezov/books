import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsActionService } from './rights-action.service';
import { RightsMaterializationService } from './rights-materialization.service';

const makeAction = (overrides: Record<string, unknown> = {}) => ({
  id: 'action-1',
  rightsProfileId: 'profile-1',
  actionType: 'OBTAIN_LICENSE',
  status: 'PENDING',
  descriptionRu: 'Купить лицензию',
  affectedCountryCodes: ['DE'],
  isBlocking: true,
  assignedToUserId: null,
  dueAt: null,
  completedAt: null,
  completedByUserId: null,
  completionNotesRu: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

interface Stub {
  rightsAction: { findUnique: jest.Mock; update: jest.Mock };
  rightsActionEvent: { create: jest.Mock };
  user: { findUnique: jest.Mock };
  $transaction: jest.Mock;
}

describe('RightsActionService', () => {
  let prisma: Stub;
  let materialization: { recomputeTerritoryDecisionsFromComponents: jest.Mock };
  let service: RightsActionService;

  beforeEach(() => {
    prisma = {
      rightsAction: {
        findUnique: jest.fn(),
        update: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve(makeAction(args.data)),
          ),
      },
      rightsActionEvent: { create: jest.fn().mockResolvedValue({ id: 'event-1' }) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

    materialization = {
      recomputeTerritoryDecisionsFromComponents: jest.fn().mockResolvedValue(null),
    };

    service = new RightsActionService(
      prisma as unknown as PrismaService,
      materialization as unknown as RightsMaterializationService,
    );
  });

  it('throws when the action does not exist', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(null);

    await expect(service.update('missing', { status: 'COMPLETED' }, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  // R3-02: до WP-5 закрыть блокирующее действие мог только агент своим отчётом.
  it('closes a blocking action and records the change in the same transaction', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction());

    const result = await service.update('action-1', { status: 'COMPLETED' }, 'user-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.isResolved).toBe(true);
    expect(prisma.rightsAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'action-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          completedByUserId: 'user-1',
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.rightsActionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rightsActionId: 'action-1',
        eventType: 'STATUS_CHANGED',
        fromStatus: 'PENDING',
        toStatus: 'COMPLETED',
        createdByUserId: 'user-1',
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('requires a comment when waiving an action', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction());

    await expect(service.update('action-1', { status: 'WAIVED' }, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.rightsAction.update).not.toHaveBeenCalled();
  });

  it('waives an action when a comment is given', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction());

    const result = await service.update(
      'action-1',
      { status: 'WAIVED', completionNotesRu: 'Лицензия не нужна: срок истёк.' },
      'user-1',
    );

    expect(result.status).toBe('WAIVED');
    expect(prisma.rightsActionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'STATUS_CHANGED',
        toStatus: 'WAIVED',
        notesRu: 'Лицензия не нужна: срок истёк.',
      }),
    });
  });

  it('rejects a transition that is not on the white list', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction({ status: 'COMPLETED' }));

    await expect(
      service.update('action-1', { status: 'WAIVED', completionNotesRu: 'x' }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('clears the completion snapshot when an action is reopened', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(
      makeAction({
        status: 'COMPLETED',
        completedAt: new Date('2026-08-01T10:00:00.000Z'),
        completedByUserId: 'user-9',
      }),
    );

    await service.update('action-1', { status: 'IN_PROGRESS' }, 'user-1');

    expect(prisma.rightsAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'IN_PROGRESS',
          completedAt: null,
          completedByUserId: null,
        }),
      }),
    );
  });

  // WP-5.5: закрытие действия на удаление — единственное подтверждение факта удаления,
  // поэтому вердикты по странам пересчитываются в той же транзакции (R6-06).
  it('recomputes territory decisions when a removal action is closed', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(
      makeAction({ actionType: 'REPLACE_ILLUSTRATIONS' }),
    );
    materialization.recomputeTerritoryDecisionsFromComponents.mockResolvedValue({
      changedCountryCodes: ['GB'],
    });

    await service.update('action-1', { status: 'COMPLETED' }, 'user-1');

    expect(materialization.recomputeTerritoryDecisionsFromComponents).toHaveBeenCalledWith(
      prisma,
      'profile-1',
    );
    expect(prisma.rightsActionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'NOTE_ADDED',
        payload: { recomputedCountryCodes: ['GB'] },
      }),
    });
  });

  it('does not recompute territory decisions for a non-removal action', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction({ actionType: 'OBTAIN_LICENSE' }));

    await service.update('action-1', { status: 'COMPLETED' }, 'user-1');

    expect(materialization.recomputeTerritoryDecisionsFromComponents).not.toHaveBeenCalled();
  });

  it('records assignment and due date changes without touching the status', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction());

    await service.update(
      'action-1',
      { assignedToUserId: 'user-2', dueAt: '2026-09-01T00:00:00.000Z' },
      'user-1',
    );

    expect(prisma.rightsAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
    const eventTypes = prisma.rightsActionEvent.create.mock.calls.map(
      (call: [{ data: { eventType: string } }]) => call[0].data.eventType,
    );
    expect(eventTypes).toEqual(expect.arrayContaining(['ASSIGNED', 'DUE_DATE_CHANGED']));
  });

  it('rejects an assignee that does not exist', async () => {
    prisma.rightsAction.findUnique.mockResolvedValue(makeAction());
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.update('action-1', { assignedToUserId: 'ghost' }, 'user-1'),
    ).rejects.toThrow(BadRequestException);
  });
});
