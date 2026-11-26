import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { StorageService } from '../../../shared/storage/storage.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { DRAFT_TX_OPTIONS } from '../content-draft/content-draft.constants';
import { LockedImageRow, WorldImageService } from './world-image.service';

const codeOf = (error: unknown): unknown =>
  error instanceof HttpException ? (error.getResponse() as { code?: unknown }).code : undefined;

const ENTITY = {
  type: 'character',
  role: 'main',
  bookVersion: { bookId: 'book-1' },
};

const LOCKED: LockedImageRow = { id: 'img-1', pendingMediaId: null, pendingDeleted: null };

describe('WorldImageService (F08-11a, F08-11d-1: without generation, F08-11d-3: file upload)', () => {
  let locked: LockedImageRow;
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    bookWorldImage: { update: jest.Mock };
    mediaAsset: { create: jest.Mock };
  };
  let storage: { save: jest.Mock; delete: jest.Mock; getPublicUrl: jest.Mock };
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
      mediaAsset: { create: jest.fn().mockResolvedValue({ id: 'm-new' }) },
    };
    storage = {
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      getPublicUrl: jest.fn((k: string) => `https://media/${k}`),
    };
    db = {
      bookWorldEntity: { findUnique: jest.fn().mockResolvedValue(ENTITY) },
      bookWorldImage: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    service = new WorldImageService(
      db as unknown as PrismaService,
      storage as unknown as StorageService,
    );
  });

  it('has no generation: no generate method, no LLM dependency', () => {
    expect((service as unknown as Record<string, unknown>).generate).toBeUndefined();
    expect(WorldImageService.length).toBe(2);
  });

  describe('upload (F08-11d-3)', () => {
    const png = (w: number, h: number): Buffer => {
      const b = Buffer.alloc(32);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
      b.write('IHDR', 12, 'latin1');
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return b;
    };
    const upload = (bytes: Buffer | undefined = png(1536, 1536)) =>
      service.upload('v-1', 'oblomov', bytes, 'user-1');

    it('stores the file, creates the asset and links it to the pending cell only', async () => {
      const bytes = png(1536, 1536);
      await upload(bytes);
      expect(storage.save).toHaveBeenCalledTimes(1);
      const [savedKey, savedBytes, savedOptions] = storage.save.mock.calls[0] as [
        string,
        Buffer,
        { contentType: string },
      ];
      expect(savedBytes).toBe(bytes);
      expect(savedOptions).toEqual({ contentType: 'image/png' });
      expect(tx.mediaAsset.create).toHaveBeenCalledTimes(1);
      expect(db.$transaction.mock.calls[0][1]).toEqual(DRAFT_TX_OPTIONS);
      const asset = tx.mediaAsset.create.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(asset.data).toMatchObject({
        contentType: 'image/png',
        width: 1536,
        height: 1536,
        createdById: 'user-1',
      });
      expect(asset.data.key).toMatch(/^illustrations[/]/);
      expect(asset.data.key).toBe(savedKey);
      expect(asset.data.url).toBe(`https://media/${savedKey}`);
      // Одна запись строки и только ожидающая ячейка: принятая не трогается до «Accept».
      expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
      expect(tx.bookWorldImage.update).toHaveBeenCalledWith({
        where: { id: 'img-1' },
        data: { pendingMediaId: 'm-new' },
      });
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it.each([
      [
        'not an image',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(40)),
        'WORLD_IMAGE_NOT_IMAGE',
      ],
      ['a side under 1200', png(1200, 1199), 'WORLD_IMAGE_TOO_SMALL'],
      ['too many pixels', png(60000, 60000), 'WORLD_IMAGE_TOO_LARGE'],
    ])('%s - 400 %s, nothing stored', async (_, bytes, code) => {
      const error = await upload(bytes).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(codeOf(error)).toBe(code);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty file', Buffer.alloc(0)],
      ['no file part', undefined],
    ])('%s - 400, nothing stored', async (_, bytes) => {
      await expect(service.upload('v-1', 'oblomov', bytes, 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(storage.save).not.toHaveBeenCalled();
    });

    // F08-12b (решение `F08 | F08-12b` R1): у места картинки нет - 409 до чтения файла, ничего не сохранено.
    it('a place - 409 WORLD_IMAGE_NOT_ALLOWED, nothing stored', async () => {
      db.bookWorldEntity.findUnique.mockResolvedValue({ ...ENTITY, type: 'place', role: null });
      expect(codeOf(await upload().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
      expect(storage.save).not.toHaveBeenCalled();
      expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
    });

    it('no entity - 404 before the file is read', async () => {
      db.bookWorldEntity.findUnique.mockResolvedValue(null);
      await expect(upload(Buffer.from('not an image'))).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('minor character - 409 WORLD_IMAGE_NOT_ALLOWED, nothing stored', async () => {
      db.bookWorldEntity.findUnique.mockResolvedValue({ ...ENTITY, role: 'minor' });
      expect(codeOf(await upload().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('a minor character with a bad file is still 409: the right is checked first', async () => {
      db.bookWorldEntity.findUnique.mockResolvedValue({ ...ENTITY, role: 'minor' });
      const error = await upload(Buffer.from('not an image')).catch((e: unknown) => e);
      expect(codeOf(error)).toBe('WORLD_IMAGE_NOT_ALLOWED');
    });

    it.each([
      ['the asset write', () => tx.mediaAsset.create.mockRejectedValue(new Error('db down'))],
      ['the cell write', () => tx.bookWorldImage.update.mockRejectedValue(new Error('db down'))],
    ])('a failed transaction at %s removes the stored file, once', async (_, fail) => {
      fail();
      await expect(upload()).rejects.toThrow('db down');
      const saved = storage.save.mock.calls[0][0] as string;
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(saved);
    });

    it('a failed save removes the partly written key; the save error goes out', async () => {
      storage.save.mockRejectedValue(new Error('storage timeout'));
      await expect(upload()).rejects.toThrow('storage timeout');
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith(storage.save.mock.calls[0][0]);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('a failed removal does not hide the original error', async () => {
      tx.mediaAsset.create.mockRejectedValue(new Error('db down'));
      storage.delete.mockRejectedValue(new Error('storage down'));
      await expect(upload()).rejects.toThrow('db down');
    });
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
