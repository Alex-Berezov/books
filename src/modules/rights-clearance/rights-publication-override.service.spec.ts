import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RIGHTS_OVERRIDE_NOT_ACTIVE,
  RightsPublicationOverrideService,
} from './rights-publication-override.service';

const GRANTED_AT = new Date('2026-09-27T10:00:00.000Z');

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'override-1',
  bookId: 'book-1',
  bookSlug: 'war-and-peace',
  reasonRu: 'Общественное достояние.',
  grantedAt: GRANTED_AT,
  grantedByUserId: 'admin-1',
  revokedAt: null,
  revokedByUserId: null,
  revokeReasonRu: null,
  grantedByUser: { email: 'admin@example.com' },
  revokedByUser: null,
  ...overrides,
});

describe('RightsPublicationOverrideService', () => {
  let tx: {
    $queryRaw: jest.Mock;
    rightsPublicationOverride: {
      findFirst: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
    };
  };
  let prisma: {
    book: { findUnique: jest.Mock };
    rightsPublicationOverride: { findFirst: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: RightsPublicationOverrideService;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      rightsPublicationOverride: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    prisma = {
      book: { findUnique: jest.fn().mockResolvedValue({ id: 'book-1', slug: 'war-and-peace' }) },
      rightsPublicationOverride: { findFirst: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    service = new RightsPublicationOverrideService(prisma as unknown as PrismaService);
  });

  describe('grant', () => {
    it('closes the active decision and opens a new one inside one locked transaction', async () => {
      tx.rightsPublicationOverride.create.mockResolvedValue(row());

      const result = await service.grant('book-1', 'Общественное достояние.', 'admin-1');

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.rightsPublicationOverride.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.rightsPublicationOverride.create).toHaveBeenCalledTimes(1);
      expect(tx.rightsPublicationOverride.updateMany).toHaveBeenCalledWith({
        where: { bookId: 'book-1', revokedAt: null },
        data: expect.objectContaining({ revokedByUserId: 'admin-1' }) as unknown,
      });
      const createArgs = tx.rightsPublicationOverride.create.mock.calls[0][0] as {
        data: { grantedAt: Date; bookId: string; grantedByUserId: string; reasonRu: string };
      };
      const revokeArgs = tx.rightsPublicationOverride.updateMany.mock.calls[0][0] as {
        data: { revokedAt: Date };
      };
      // Прежнее решение закрыто тем же моментом, которым открыто новое: разрыва и наложения нет.
      expect(createArgs.data.grantedAt).toBe(revokeArgs.data.revokedAt);
      expect(createArgs.data).toMatchObject({
        bookId: 'book-1',
        bookSlug: 'war-and-peace',
        grantedByUserId: 'admin-1',
        reasonRu: 'Общественное достояние.',
      });
      expect(result).toMatchObject({
        id: 'override-1',
        grantedAt: GRANTED_AT.toISOString(),
        grantedByEmail: 'admin@example.com',
        revokedAt: null,
      });
    });

    it('refuses a book that does not exist', async () => {
      prisma.book.findUnique.mockResolvedValue(null);

      await expect(service.grant('missing', 'Причина решения.', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('revokes the active decision with the author and the reason', async () => {
      tx.rightsPublicationOverride.findFirst.mockResolvedValue({ id: 'override-1' });
      tx.rightsPublicationOverride.update.mockResolvedValue(
        row({
          revokedAt: new Date('2026-09-28T00:00:00.000Z'),
          revokedByUserId: 'admin-2',
          revokeReasonRu: 'Ошибся книгой.',
          revokedByUser: { email: 'other@example.com' },
        }),
      );

      const result = await service.revoke('book-1', 'Ошибся книгой.', 'admin-2');

      expect(tx.rightsPublicationOverride.update).toHaveBeenCalledTimes(1);
      expect(tx.rightsPublicationOverride.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'override-1' },
          data: expect.objectContaining({
            revokedByUserId: 'admin-2',
            revokeReasonRu: 'Ошибся книгой.',
          }) as unknown,
        }),
      );
      expect(result.revokedByEmail).toBe('other@example.com');
    });

    it('answers 409 RIGHTS_OVERRIDE_NOT_ACTIVE when there is nothing to revoke', async () => {
      tx.rightsPublicationOverride.findFirst.mockResolvedValue(null);

      const error = await service.revoke('book-1', undefined, 'admin-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: RIGHTS_OVERRIDE_NOT_ACTIVE,
      });
      expect(tx.rightsPublicationOverride.update).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('reports the non-revoked decision as active and keeps the whole history', async () => {
      prisma.rightsPublicationOverride.findMany.mockResolvedValue([
        row({ id: 'override-2' }),
        row({ id: 'override-1', revokedAt: GRANTED_AT, revokedByUserId: 'admin-1' }),
      ]);

      const state = await service.getState('book-1');

      expect(state.active?.id).toBe('override-2');
      expect(state.history.map((item) => item.id)).toEqual(['override-2', 'override-1']);
    });

    it('has no active decision when every decision is revoked', async () => {
      prisma.rightsPublicationOverride.findMany.mockResolvedValue([row({ revokedAt: GRANTED_AT })]);

      const state = await service.getState('book-1');

      expect(state.active).toBeNull();
      expect(state.history).toHaveLength(1);
    });
  });

  it('findActiveForBook reads only non-revoked decisions, newest first', async () => {
    prisma.rightsPublicationOverride.findFirst.mockResolvedValue(null);

    await service.findActiveForBook('book-1');

    expect(prisma.rightsPublicationOverride.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.rightsPublicationOverride.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookId: 'book-1', revokedAt: null },
        orderBy: { grantedAt: 'desc' },
      }),
    );
  });
});
