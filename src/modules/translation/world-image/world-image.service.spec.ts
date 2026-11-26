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

/** Строка под замком глазами правила занятости ключа (`F08 | F08-12c-2` круг 1 Q1): тип и файлы. */
interface OccupancyMock {
  entityType: string;
  imageReadAt: Date | null;
  image: { id: string; url: string; width: number; height: number; isDeleted: boolean } | null;
  pending: { id: string; url: string; width: number; height: number; isDeleted: boolean } | null;
}

const EMPTY_ROW: OccupancyMock = {
  entityType: 'character',
  imageReadAt: null,
  image: null,
  pending: null,
};

const LIVE = {
  id: 'm-old',
  url: 'https://media/old.png',
  width: 1536,
  height: 1536,
  isDeleted: false,
};
const DEAD = { ...LIVE, isDeleted: true };
const MAIN_OWNER = [{ type: 'character', role: 'main' }];
const PLACE_OWNER = [{ type: 'place', role: null }];

/** Перевод строки на тип сущности с очисткой ячеек - одна запись под замком. */
const MOVED_TO_PLACE = {
  where: { id: 'img-1' },
  data: {
    entityType: 'place',
    imageMediaId: null,
    imageReadAt: null,
    pendingMediaId: null,
    operationId: null,
  },
};

const PLACE = { type: 'place', role: null, bookVersion: { bookId: 'book-1' } };

/** Текст сырого SQL-шаблона вызова `$executeRaw`/`$queryRaw` мока. */
const sqlOf = (call: unknown[]): string => (call[0] as TemplateStringsArray).join('?');

describe('WorldImageService (F08-11a, F08-11d-1: without generation, F08-11d-3: file upload)', () => {
  let locked: LockedImageRow;
  let occupancy: OccupancyMock;
  // Сущности ключа в других версиях книги (`v-2`); своя (`v-1`) под замком - как прочитана до него,
  // если тест не сменил её (`ownLocked`) - импорт между чтением и замком (круг 2).
  let owners: Array<{ type: string; role: string | null }>;
  let subjectEntity: { type: string; role: string | null; bookVersion: { bookId: string } } | null;
  let ownLocked: { type: string; role: string | null } | null;
  const setSubject = (entity: typeof subjectEntity) => {
    subjectEntity = entity;
    ownLocked = entity ? { type: entity.type, role: entity.role } : null;
  };
  const keyEntities = () => [
    ...(ownLocked ? [{ bookVersionId: 'v-1', ...ownLocked }] : []),
    ...owners.map((o) => ({ bookVersionId: 'v-2', ...o })),
  ];
  /** Вызов `$queryRaw`, читающий сущности ключа под `FOR SHARE`. */
  const entitiesQuery = () =>
    (tx.$queryRaw.mock.calls as unknown[][]).find((c) => sqlOf(c).includes('"BookWorldEntity"'));
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    bookWorldImage: { update: jest.Mock; findUniqueOrThrow: jest.Mock };
    mediaAsset: { create: jest.Mock };
  };
  let storage: { save: jest.Mock; delete: jest.Mock; getPublicUrl: jest.Mock };
  let db: {
    bookWorldEntity: { findUnique: jest.Mock; findMany: jest.Mock };
    bookWorldImage: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: WorldImageService;

  beforeEach(() => {
    locked = { ...LOCKED };
    occupancy = { ...EMPTY_ROW };
    owners = [];
    subjectEntity = ENTITY;
    ownLocked = { type: ENTITY.type, role: ENTITY.role };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn((sql: TemplateStringsArray) =>
        Promise.resolve(sql.join('?').includes('"BookWorldEntity"') ? keyEntities() : [locked]),
      ),
      bookWorldImage: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(occupancy)),
      },
      mediaAsset: { create: jest.fn().mockResolvedValue({ id: 'm-new' }) },
    };
    storage = {
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      getPublicUrl: jest.fn((k: string) => `https://media/${k}`),
    };
    db = {
      bookWorldEntity: {
        findUnique: jest.fn(() => Promise.resolve(subjectEntity)),
        findMany: jest.fn(() => Promise.resolve(keyEntities())),
      },
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

    // F08-12c-2 (решение `F08 | F08-12c-2`): у места картинка есть - предел от 1200×675 (круг 1 Q3).
    describe('a place (F08-12c-2)', () => {
      beforeEach(() => {
        setSubject(PLACE);
        occupancy = { ...EMPTY_ROW, entityType: 'place' };
      });

      it('a file of 1200x675 is stored into the pending cell', async () => {
        await upload(png(1200, 675));
        expect(storage.save).toHaveBeenCalledTimes(1);
        expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
        expect(tx.bookWorldImage.update).toHaveBeenCalledWith({
          where: { id: 'img-1' },
          data: { pendingMediaId: 'm-new' },
        });
      });

      it.each([
        ['height under 675', png(1200, 674)],
        ['width under 1200', png(1199, 675)],
      ])('%s - 400 WORLD_IMAGE_TOO_SMALL, nothing stored', async (_, bytes) => {
        expect(codeOf(await upload(bytes).catch((e: unknown) => e))).toBe('WORLD_IMAGE_TOO_SMALL');
        expect(storage.save).not.toHaveBeenCalled();
      });

      it('the new row is created with the type of the entity', async () => {
        await upload(png(1600, 900));
        const insert = tx.$executeRaw.mock.calls[0] as unknown[];
        expect(sqlOf(insert)).toContain('"entityType"');
        expect(insert).toContain('place');
      });
    });

    it('a hero keeps the portrait limit: 1200x675 is too small', async () => {
      expect(codeOf(await upload(png(1200, 675)).catch((e: unknown) => e))).toBe(
        'WORLD_IMAGE_TOO_SMALL',
      );
    });

    // Решения `F08 | F08-12c-2` (круг 1 Q1): строка ключа другого типа занята, только если у неё живой
    // файл и в книге есть сущность её типа с правом на картинку; свободная переводится с очисткой.
    describe('the key row belongs to another type', () => {
      beforeEach(() => {
        setSubject(PLACE);
      });

      it.each([
        ['a live accepted image', { imageReadAt: new Date(), image: LIVE }],
        ['a live pending image', { pending: LIVE }],
      ])(
        'a place over a hero row with %s and a main hero in the book - 409 WORLD_IMAGE_KEY_CONFLICT, file removed',
        async (_, cells) => {
          occupancy = { ...EMPTY_ROW, ...cells };
          owners = MAIN_OWNER;
          const error = await upload(png(1600, 900)).catch((e: unknown) => e);
          expect(codeOf(error)).toBe('WORLD_IMAGE_KEY_CONFLICT');
          expect(tx.mediaAsset.create).not.toHaveBeenCalled();
          expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
          expect(storage.delete).toHaveBeenCalledTimes(1);
          expect(storage.delete).toHaveBeenCalledWith(storage.save.mock.calls[0][0]);
          const query = entitiesQuery();
          expect(query).toBeDefined();
          expect(sqlOf(query as unknown[])).toContain('FOR SHARE OF e');
          expect(query).toEqual(expect.arrayContaining(['book-1', 'oblomov']));
        },
      );

      it('a hero over a place row with a live image and a place in the book - 409', async () => {
        setSubject(ENTITY);
        occupancy = { ...EMPTY_ROW, entityType: 'place', imageReadAt: new Date(), image: LIVE };
        owners = PLACE_OWNER;
        expect(codeOf(await upload().catch((e: unknown) => e))).toBe('WORLD_IMAGE_KEY_CONFLICT');
        expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
      });

      it.each([
        ['an empty row (a leftover operationId is not read)', {}, MAIN_OWNER],
        ['a deleted accepted file', { imageReadAt: new Date(), image: DEAD }, MAIN_OWNER],
        ['a deleted pending file', { pending: DEAD }, MAIN_OWNER],
        ['an accepted image never accepted (no imageReadAt)', { image: LIVE }, MAIN_OWNER],
        [
          'a live image whose hero lost the right',
          { imageReadAt: new Date(), image: LIVE },
          [{ type: 'character', role: 'minor' }],
        ],
        [
          'a live image with no hero on the key any more (type changed)',
          { imageReadAt: new Date(), image: LIVE },
          [],
        ],
      ])(
        '%s - the row is moved to the place type with cleared cells, then the file goes to pending',
        async (_, cells, who) => {
          occupancy = { ...EMPTY_ROW, ...cells };
          owners = who;
          await upload(png(1600, 900));
          expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(2);
          expect(tx.bookWorldImage.update.mock.calls[0][0]).toEqual(MOVED_TO_PLACE);
          expect(tx.bookWorldImage.update.mock.calls[1][0]).toEqual({
            where: { id: 'img-1' },
            data: { pendingMediaId: 'm-new' },
          });
          expect(storage.delete).not.toHaveBeenCalled();
        },
      );

      it('a row of the same type is not rewritten', async () => {
        setSubject(ENTITY);
        occupancy = { ...EMPTY_ROW, imageReadAt: new Date(), image: LIVE };
        owners = PLACE_OWNER;
        await upload();
        expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      });

      it('the entities of the key and the row are read after the row lock, by their own statements (L-019)', async () => {
        await upload(png(1600, 900));
        expect(sqlOf(tx.$queryRaw.mock.calls[0] as unknown[])).toContain('FOR UPDATE');
        const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
        const entitiesOrder = tx.$queryRaw.mock.invocationCallOrder[1];
        expect(sqlOf(tx.$queryRaw.mock.calls[1] as unknown[])).toContain('FOR SHARE OF e');
        const readOrder = tx.bookWorldImage.findUniqueOrThrow.mock.invocationCallOrder[0];
        expect(entitiesOrder).toBeGreaterThan(lockOrder);
        expect(readOrder).toBeGreaterThan(entitiesOrder);
      });
    });

    // Круг 2: своя сущность сверяется под замком - импорт мира мог сменить её тип или роль.
    describe('the own entity changed between the read and the lock', () => {
      it('its type changed - 409 WORLD_IMAGE_ENTITY_CHANGED, nothing written, file removed', async () => {
        setSubject(PLACE);
        ownLocked = { type: 'character', role: 'main' };
        const error = await upload(png(1600, 900)).catch((e: unknown) => e);
        expect(codeOf(error)).toBe('WORLD_IMAGE_ENTITY_CHANGED');
        expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
        expect(tx.mediaAsset.create).not.toHaveBeenCalled();
        expect(storage.delete).toHaveBeenCalledTimes(1);
      });

      it('the hero lost the right - 409 WORLD_IMAGE_NOT_ALLOWED under the lock', async () => {
        ownLocked = { type: 'character', role: 'minor' };
        expect(codeOf(await upload().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
        expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
      });

      // Круг 4: роль сменилась с сохранением права (main -> secondary) - не отказ, загрузка проходит.
      it('the role changed but the right stays (main to secondary) - the upload goes through', async () => {
        ownLocked = { type: 'character', role: 'secondary' };
        await upload();
        expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
        expect(tx.bookWorldImage.update).toHaveBeenCalledWith({
          where: { id: 'img-1' },
          data: { pendingMediaId: 'm-new' },
        });
        expect(storage.delete).not.toHaveBeenCalled();
      });

      it('the entity is gone - 404, nothing written', async () => {
        ownLocked = null;
        await expect(upload()).rejects.toBeInstanceOf(NotFoundException);
        expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
      });

      it('Accept: the type changed - 409 WORLD_IMAGE_ENTITY_CHANGED', async () => {
        ownLocked = { type: 'place', role: null };
        locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
        const error = await service.accept('v-1', 'oblomov', 'm-pending').catch((e: unknown) => e);
        expect(codeOf(error)).toBe('WORLD_IMAGE_ENTITY_CHANGED');
        expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
      });
    });

    it('no entity - 404 before the file is read', async () => {
      setSubject(null);
      await expect(upload(Buffer.from('not an image'))).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('minor character - 409 WORLD_IMAGE_NOT_ALLOWED, nothing stored', async () => {
      setSubject({ ...ENTITY, role: 'minor' });
      expect(codeOf(await upload().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('a minor character with a bad file is still 409: the right is checked first', async () => {
      setSubject({ ...ENTITY, role: 'minor' });
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

    it('a place accepts its own pending image (F08-12c-2)', async () => {
      setSubject(PLACE);
      occupancy = { ...EMPTY_ROW, entityType: 'place', pending: LIVE };
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      await accept();
      expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
    });

    it('a place over a hero row with a live pending image of a main hero - 409 WORLD_IMAGE_KEY_CONFLICT', async () => {
      setSubject(PLACE);
      occupancy = { ...EMPTY_ROW, pending: LIVE };
      owners = MAIN_OWNER;
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      expect(codeOf(await accept().catch((e: unknown) => e))).toBe('WORLD_IMAGE_KEY_CONFLICT');
      expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
    });

    it.each([
      ['a minor character', { ...ENTITY, role: 'minor' }],
      ['a pair', { ...ENTITY, type: 'pair', role: null }],
    ])('%s - 409 WORLD_IMAGE_NOT_ALLOWED (Q1)', async (_, entity) => {
      setSubject(entity);
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      expect(codeOf(await accept().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('no entity - 404', async () => {
      setSubject(null);
      await expect(accept()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('state', () => {
    const FILE = { id: 'm-1', url: 'https://media/a.png', width: 1536, height: 1536 };

    it('accepted by the same rule as the site, pending without the deleted file; no generation fields', async () => {
      db.bookWorldImage.findUnique.mockResolvedValue({
        entityType: 'character',
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
        keyConflict: false,
      });
      expect(db.bookWorldEntity.findMany).not.toHaveBeenCalled();
    });

    it('a deleted accepted file is not shown as accepted', async () => {
      db.bookWorldImage.findUnique.mockResolvedValue({
        entityType: 'character',
        imageReadAt: new Date(),
        image: { ...FILE, isDeleted: true },
        pending: null,
      });
      const state = await service.state('v-1', 'oblomov');
      expect(state).toMatchObject({ accepted: null, acceptedAt: null });
    });

    it.each([
      ['a main hero still has the right', MAIN_OWNER, true],
      ['the hero lost the right', [{ type: 'character', role: 'minor' }], false],
      ['no hero on the key any more', [], false],
    ])(
      'a live row of another type is shown empty; %s - keyConflict %s (circle 1 Q2)',
      async (_, who, conflict) => {
        setSubject(PLACE);
        owners = who;
        db.bookWorldImage.findUnique.mockResolvedValue({
          entityType: 'character',
          imageReadAt: new Date(),
          image: { ...FILE, isDeleted: false },
          pending: { ...FILE, id: 'm-2', isDeleted: false },
        });
        expect(await service.state('v-1', 'oblomov')).toMatchObject({
          allowed: true,
          accepted: null,
          acceptedAt: null,
          pending: null,
          keyConflict: conflict,
        });
        expect(db.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
        expect(db.bookWorldEntity.findMany.mock.calls[0][0]).toMatchObject({
          where: { key: 'oblomov', bookVersion: { bookId: 'book-1' } },
        });
      },
    );

    it('a row of another type with only deleted files is free: keyConflict false', async () => {
      setSubject(PLACE);
      owners = MAIN_OWNER;
      db.bookWorldImage.findUnique.mockResolvedValue({
        entityType: 'character',
        imageReadAt: new Date(),
        image: { ...FILE, isDeleted: true },
        pending: null,
      });
      expect(await service.state('v-1', 'oblomov')).toMatchObject({ keyConflict: false });
    });

    it('allowed is the type and role alone (Q10): main, secondary and a place yes, minor and a pair no, appearance not read', async () => {
      for (const [entity, allowed] of [
        [ENTITY, true],
        [{ ...ENTITY, role: 'secondary' }, true],
        [PLACE, true],
        [{ ...ENTITY, role: 'minor' }, false],
        [{ ...ENTITY, type: 'pair', role: null }, false],
      ] as const) {
        setSubject(entity);
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
