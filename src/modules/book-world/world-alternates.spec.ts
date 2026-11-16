import { Language } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  VERSIONS_PER_BOOK,
  worldAlternates,
  worldCluster,
  type WorldSibling,
} from './world-alternates';

const v = (
  id: string,
  language: Language,
  slug: string | null,
  keys: [string, boolean][],
): WorldSibling => ({
  id,
  bookId: 'b1',
  language,
  slug,
  worldEntities: keys.map(([key, isIndexable]) => ({ key, isIndexable })),
});

describe('worldCluster / worldAlternates (решения арбитра F08 | F08-3 Q1, Q4; F08 | F08-3a hreflang)', () => {
  const en = v('v-en', Language.en, 'book-en', [
    ['anna', true],
    ['mira', false],
  ]);
  const ru = v('v-ru', Language.ru, 'book-ru', [['anna', true]]);

  it('общая страница: языки, где есть мир; своя версия первой', () => {
    expect(worldCluster('v-ru', [en, ru])).toEqual([
      { language: 'ru', slug: 'book-ru' },
      { language: 'en', slug: 'book-en' },
    ]);
  });

  it('сущность isIndexable=false — пустой кластер; ключ, которого нет у соседа, — без него', () => {
    expect(worldCluster('v-en', [en, ru], 'mira')).toEqual([]);
    expect(worldCluster('v-en', [en, ru], 'anna')).toEqual([
      { language: 'en', slug: 'book-en' },
      { language: 'ru', slug: 'book-ru' },
    ]);
    expect(
      worldCluster('v-en', [en, v('v-fr', Language.fr, 'book-fr', [['zed', true]])], 'anna'),
    ).toEqual([{ language: 'en', slug: 'book-en' }]);
  });

  it('своей версии среди открытых нет (черновик, noindex) — пустой кластер', () => {
    expect(worldCluster('v-draft', [en, ru])).toEqual([]);
  });

  it('worldAlternates: два запроса по книге версии, соседей не больше числа языков', async () => {
    const seo = { findMany: jest.fn().mockResolvedValue([{ id: 3, robots: 'noindex' }]) };
    const bookVersion = { findMany: jest.fn().mockResolvedValue([en, ru]) };
    const db = { seo, bookVersion } as unknown as PrismaClient;
    await expect(worldAlternates(db, 'v-en', 'anna')).resolves.toEqual([
      { language: 'en', slug: 'book-en' },
      { language: 'ru', slug: 'book-ru' },
    ]);
    const sameBook = { book: { versions: { some: { id: 'v-en' } } } };
    expect(seo.findMany).toHaveBeenCalledTimes(1);
    expect(seo.findMany.mock.calls[0][0].where.bookVersion).toEqual({
      AND: [sameBook, { status: 'published' }],
    });
    expect(bookVersion.findMany).toHaveBeenCalledTimes(1);
    const arg = bookVersion.findMany.mock.calls[0][0];
    expect(arg.take).toBe(VERSIONS_PER_BOOK);
    expect(arg.where.AND[0]).toEqual(sameBook);
    expect(JSON.stringify(arg.where)).toContain('"notIn":[3]');
  });
});
