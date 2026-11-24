import { HttpException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LockedImageRow, WorldImageService } from './world-image.service';

const codeOf = (error: unknown): unknown =>
  error instanceof HttpException ? (error.getResponse() as { code?: unknown }).code : undefined;

const ENTITY = {
  type: 'character',
  role: 'main',
  bookVersion: { bookId: 'book-1' },
};

const LOCKED: LockedImageRow = { id: 'img-1', pendingMediaId: null, pendingDeleted: null };

describe('WorldImageService (F08-11a, F08-11d-1: without generation)', () => {
  let locked: LockedImageRow;
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    bookWorldImage: { update: jest.Mock };
  };
  let db: {
    bookWorldEntity: { findUnique: jest.Mock };
    bookWorldImage: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: WorldImageService;

  beforeEach(() => {
    locked = { ...LOCKED };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(() => Promise.resolve([locked])),
      bookWorldImage: { update: jest.fn().mockResolvedValue({}) },
    };
    db = {
      bookWorldEntity: { findUnique: jest.fn().mockResolvedValue(ENTITY) },
      bookWorldImage: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    service = new WorldImageService(db as unknown as PrismaService);
  });

  it('has no generation: no generate method, no LLM dependency', () => {
    expect((service as unknown as Record<string, unknown>).generate).toBeUndefined();
    expect(WorldImageService.length).toBe(1);
  });

  describe('accept', () => {
    const accept = (id = 'm-pending') => service.accept('v-1', 'oblomov', id);

    it('moves the pending image to the accepted cell', async () => {
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      await accept();
      expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
      const call = tx.bookWorldImage.update.mock.calls[0][0] as {
        where: unknown;
        data: { imageMediaId: string; imageReadAt: Date; pendingMediaId: null };
      };
      expect(call.where).toEqual({ id: 'img-1' });
      expect(call.data).toMatchObject({ imageMediaId: 'm-pending', pendingMediaId: null });
      expect(call.data.imageReadAt).toBeInstanceOf(Date);
    });

    it.each([
      ['nothing pending', { pendingMediaId: null, pendingDeleted: null }, 'WORLD_IMAGE_NONE'],
      [
        'the pending file was deleted',
        { pendingMediaId: 'm-pending', pendingDeleted: true },
        'WORLD_IMAGE_NONE',
      ],
      [
        'another pending image',
        { pendingMediaId: 'm-other', pendingDeleted: false },
        'WORLD_IMAGE_CHANGED',
      ],
    ])('%s - 409 %s', async (_, cell, code) => {
      locked = { ...LOCKED, ...cell };
      expect(codeOf(await accept().catch((e: unknown) => e))).toBe(code);
      expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
    });

    it.each([
      ['a minor character', { ...ENTITY, role: 'minor' }],
      ['a pair', { ...ENTITY, type: 'pair', role: null }],
    ])('%s - 409 WORLD_IMAGE_NOT_ALLOWED (Q1)', async (_, entity) => {
      db.bookWorldEntity.findUnique.mockResolvedValue(entity);
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      expect(codeOf(await accept().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('no entity - 404', async () => {
      db.bookWorldEntity.findUnique.mockResolvedValue(null);
      await expect(accept()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('state', () => {
    const FILE = { id: 'm-1', url: 'https://media/a.png', width: 1536, height: 1536 };

    it('accepted by the same rule as the site, pending without the deleted file; no generation fields', async () => {
      db.bookWorldImage.findUnique.mockResolvedValue({
        imageReadAt: new Date('2026-11-23T10:00:00Z'),
        image: { ...FILE, isDeleted: false },
        pending: { ...FILE, id: 'm-2', isDeleted: true },
      });
      const state = await service.state('v-1', 'oblomov');
      expect(state).toEqual({
        key: 'oblomov',
        allowed: true,
        roleAllowed: true,
        accepted: { mediaId: 'm-1', url: FILE.url, width: 1536, height: 1536 },
        acceptedAt: new Date('2026-11-23T10:00:00Z'),
        pending: null,
      });
    });

    it('a deleted accepted file is not shown as accepted', async () => {
      db.bookWorldImage.findUnique.mockResolvedValue({
        imageReadAt: new Date(),
        image: { ...FILE, isDeleted: true },
        pending: null,
      });
      const state = await service.state('v-1', 'oblomov');
      expect(state).toMatchObject({ accepted: null, acceptedAt: null });
    });

    it('allowed is the role alone (Q10): main and secondary yes, minor and a pair no, appearance not read', async () => {
      for (const [entity, allowed] of [
        [ENTITY, true],
        [{ ...ENTITY, role: 'secondary' }, true],
        [{ ...ENTITY, role: 'minor' }, false],
        [{ ...ENTITY, type: 'pair', role: null }, false],
      ] as const) {
        db.bookWorldEntity.findUnique.mockResolvedValue(entity);
        expect(await service.state('v-1', 'oblomov')).toMatchObject({
          allowed,
          roleAllowed: allowed,
        });
      }
      const query = db.bookWorldEntity.findUnique.mock.calls[0][0] as {
        select: Record<string, unknown>;
      };
      expect(query.select).not.toHaveProperty('blocks');
    });
  });
});
