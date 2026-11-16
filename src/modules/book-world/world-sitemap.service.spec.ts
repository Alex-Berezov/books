import { Language } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { WorldSitemapService } from './world-sitemap.service';
import { VERSIONS_PER_BOOK, type WorldSibling } from './world-alternates';
import { WORLD_ENTITY_PUBLIC_WHERE } from './world-public';

const EARLY = new Date('2026-11-01T00:00:00Z');
const LATE = new Date('2026-11-10T00:00:00Z');

function setup(opts: {
  rows: unknown[];
  siblings: WorldSibling[];
  noindex?: { id: number; robots: string }[];
}) {
  const findMany = jest.fn().mockResolvedValueOnce(opts.rows).mockResolvedValueOnce(opts.siblings);
  const count = jest.fn().mockResolvedValue(opts.rows.length);
  const seo = { findMany: jest.fn().mockResolvedValue(opts.noindex ?? []) };
  const db = { bookVersion: { findMany, count }, seo };
  return { service: new WorldSitemapService(db as unknown as PrismaService), findMany, count, seo };
}

const row = {
  id: 'v-en',
  bookId: 'b1',
  worldEntities: [
    { key: 'anna', isIndexable: true, updatedAt: EARLY },
    { key: 'mira', isIndexable: false, updatedAt: LATE },
  ],
};
const sibling = (
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
const self = sibling('v-en', Language.en, 'book-en', [
  ['anna', true],
  ['mira', false],
]);

describe('WorldSitemapService (F08-3, решения арбитра Q1, Q4, Q10, Q12)', () => {
  it('общая страница — всегда, сущности — только isIndexable; lastmod — наибольший updatedAt', async () => {
    const { service } = setup({ rows: [row], siblings: [self] });
    const res = await service.sitemap(Language.en, 1, 50);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].slug).toBe('book-en');
    expect(res.items[0].lastmod).toEqual(LATE);
    expect(res.items[0].entities.map((e) => e.key)).toEqual(['anna']);
    expect(res.items[0].alternates).toEqual([{ language: 'en', slug: 'book-en' }]);
  });

  it('кластер: своя версия первой, язык один раз, без слага — мимо, сущность — по ключу и isIndexable', async () => {
    const { service } = setup({
      rows: [row],
      siblings: [
        sibling('v-a', Language.ru, 'book-ru', [['anna', true]]),
        sibling('v-c', Language.fr, null, [['anna', true]]),
        sibling('v-d', Language.es, 'book-es', [['anna', false]]),
        self,
      ],
    });
    const [item] = (await service.sitemap(Language.en, 1, 50)).items;
    expect(item.alternates).toEqual([
      { language: 'en', slug: 'book-en' },
      { language: 'ru', slug: 'book-ru' },
      { language: 'es', slug: 'book-es' },
    ]);
    expect(item.entities[0].alternates).toEqual([
      { language: 'en', slug: 'book-en' },
      { language: 'ru', slug: 'book-ru' },
    ]);
  });

  it('выборки: одно условие на страницу и total; noindex — один раз, по версиям с миром; соседи — версии книг страницы', async () => {
    const { service, findMany, count, seo } = setup({
      rows: [row],
      siblings: [self],
      noindex: [{ id: 7, robots: 'noindex, follow' }],
    });
    await service.sitemap(Language.en, 2, 10);
    expect(seo.findMany).toHaveBeenCalledTimes(1);
    expect(seo.findMany.mock.calls[0][0].where.bookVersion).toEqual({
      status: 'published',
      worldEntities: { some: WORLD_ENTITY_PUBLIC_WHERE },
    });
    const page = findMany.mock.calls[0][0];
    expect(count.mock.calls[0][0].where).toEqual(page.where);
    expect(JSON.stringify(page.where)).toContain('"notIn":[7]');
    expect(page.where.AND[0]).toEqual({
      language: Language.en,
      worldEntities: { some: WORLD_ENTITY_PUBLIC_WHERE },
    });
    expect(page.skip).toBe(10);
    expect(page.take).toBe(10);
    const siblings = findMany.mock.calls[1][0];
    expect(siblings.take).toBe(VERSIONS_PER_BOOK);
    expect(JSON.stringify(siblings.where)).toContain('"notIn":[7]');
    expect(JSON.stringify(siblings.where)).toContain('"status":"published"');
  });

  it('версия страницы выпала из соседей (стала noindex между запросами) — в карту не идёт', async () => {
    const { service } = setup({ rows: [row], siblings: [] });
    expect((await service.sitemap(Language.en, 1, 50)).items).toEqual([]);
  });

  it('пустая страница — соседей не спрашивает', async () => {
    const { service, findMany } = setup({ rows: [], siblings: [] });
    const res = await service.sitemap(Language.en, 9, 50);
    expect(res.items).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
