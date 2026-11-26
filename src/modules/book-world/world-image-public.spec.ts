import { Prisma } from '@prisma/client';
import { acceptedImageOf, acceptedWorldImage, worldImageAllowed } from './world-image-public';

const FILE = { id: 'm-1', url: 'https://media/x.png', width: 1536, height: 1536, isDeleted: false };
const MAIN = { type: 'character', role: 'main' };

describe('world image public (F08-11a, решения F08 | F08-11 Р3, F08 | F08-11a Q1)', () => {
  describe('worldImageAllowed', () => {
    it.each([
      [{ type: 'character', role: 'main' }, true],
      [{ type: 'character', role: 'secondary' }, true],
      [{ type: 'character', role: 'minor' }, false],
      [{ type: 'character', role: null }, false],
      [{ type: 'pair', role: null }, false],
      // F08-12c-2 (решение `F08 | F08-12c-2`): у места картинка есть, любого вида; подмену на общем
      // ключе закрывает тип строки (`entityType`), а не право.
      [{ type: 'place', role: 'main' }, true],
      [{ type: 'place', role: null }, true],
    ])('%j -> %s', (entity, allowed) => {
      expect(worldImageAllowed(entity)).toBe(allowed);
    });
  });

  describe('acceptedImageOf', () => {
    it('the accepted cell with imageReadAt and a live file', () => {
      expect(acceptedImageOf({ imageReadAt: new Date(), image: FILE })).toBe(FILE);
    });

    it.each([
      ['not accepted yet', { imageReadAt: null, image: FILE }],
      ['the file is deleted', { imageReadAt: new Date(), image: { ...FILE, isDeleted: true } }],
      ['no file', { imageReadAt: new Date(), image: null }],
    ])('%s - null', (_, row) => {
      expect(acceptedImageOf(row)).toBeNull();
    });
  });

  describe('acceptedWorldImage', () => {
    const client = (row: unknown) => {
      const findFirst = jest.fn().mockResolvedValue(row);
      return {
        findFirst,
        tx: { bookWorldImage: { findFirst } } as unknown as Prisma.TransactionClient,
      };
    };

    it('reads only the accepted cell of the book of this version, never the pending one', async () => {
      const db = client({ imageReadAt: new Date(), image: FILE });
      await expect(acceptedWorldImage(db.tx, 'v-1', 'oblomov', MAIN)).resolves.toEqual({
        url: FILE.url,
        width: 1536,
        height: 1536,
      });
      expect(db.findFirst).toHaveBeenCalledTimes(1);
      const args = db.findFirst.mock.calls[0][0] as {
        where: unknown;
        select: Record<string, unknown>;
      };
      expect(args.where).toEqual({
        key: 'oblomov',
        entityType: 'character',
        book: { versions: { some: { id: 'v-1' } } },
      });
      expect(Object.keys(args.select).sort()).toEqual(['image', 'imageReadAt']);
    });

    it.each([
      ['not accepted', { imageReadAt: null, image: FILE }],
      ['deleted file', { imageReadAt: new Date(), image: { ...FILE, isDeleted: true } }],
      ['no row', null],
    ])('%s - null', async (_, row) => {
      await expect(acceptedWorldImage(client(row).tx, 'v-1', 'k', MAIN)).resolves.toBeNull();
    });

    // F08-12c-2: тип строки - тип сущности этой версии; строка героя месту на том же ключе не видна.
    it('a place reads only a row of the place type', async () => {
      const db = client(null);
      await expect(
        acceptedWorldImage(db.tx, 'v-1', 'quay', { type: 'place', role: null }),
      ).resolves.toBeNull();
      expect(db.findFirst).toHaveBeenCalledTimes(1);
      const args = db.findFirst.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(args.where.entityType).toBe('place');
    });

    it.each([
      ['minor', { type: 'character', role: 'minor' }],
      ['pair', { type: 'pair', role: null }],
    ])('a %s of this version gets no image, without reading the row (Q1)', async (_, entity) => {
      const db = client({ imageReadAt: new Date(), image: FILE });
      await expect(acceptedWorldImage(db.tx, 'v-1', 'k', entity)).resolves.toBeNull();
      expect(db.findFirst).not.toHaveBeenCalled();
    });
  });
});
