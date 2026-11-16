import type { PrismaClient } from '@prisma/client';
import { SITEMAP_NOINDEX_SEO_LIMIT, noindexSeoIds, notNoindexWhere } from './noindex-seo';

describe('noindex-seo (решения арбитра F04 | F04-1 п.4, F08 | F08-3 Q4)', () => {
  it('notNoindexWhere: пустой список — без условия; иначе версия без Seo проходит отдельной веткой', () => {
    expect(notNoindexWhere([])).toEqual({});
    expect(notNoindexWhere([1, 2])).toEqual({
      OR: [{ seoId: null }, { seoId: { notIn: [1, 2] } }],
    });
  });

  it('noindexSeoIds: отбор общим разборщиком robots, кандидаты по подстроке и в пределе', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 1, robots: 'noindex, follow' },
      { id: 2, robots: 'index, follow, max-snippet:none-ish' },
      { id: 3, robots: 'none' },
    ]);
    const db = { seo: { findMany } } as unknown as PrismaClient;
    await expect(noindexSeoIds(db, { status: 'published' })).resolves.toEqual([1, 3]);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.bookVersion).toEqual({ status: 'published' });
    expect(arg.take).toBe(SITEMAP_NOINDEX_SEO_LIMIT + 1);
  });

  it('сверх предела — 503, а не урезанный список', async () => {
    const rows = Array.from({ length: SITEMAP_NOINDEX_SEO_LIMIT + 1 }, (_, i) => ({
      id: i,
      robots: 'noindex',
    }));
    const db = { seo: { findMany: jest.fn().mockResolvedValue(rows) } } as unknown as PrismaClient;
    await expect(noindexSeoIds(db, {})).rejects.toMatchObject({ status: 503 });
  });
});
