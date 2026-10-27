import { Prisma } from '@prisma/client';
import { allChapters, CHAPTER_PAGE_SIZE, chapterPages } from './chapter-pages';

interface FindArgs {
  where: { bookVersionId: string; number: { gt?: number; gte?: number; lte?: number } };
  orderBy: { number: 'asc' };
  take: number;
}

/** База с главами 1..total одной версии: выборка исполняет where, orderBy и take, как Prisma. */
const fakeDb = (total: number) => {
  const calls: FindArgs[] = [];
  const findMany = (args: FindArgs) => {
    calls.push(args);
    const { gt, gte, lte } = args.where.number;
    return Promise.resolve(
      Array.from({ length: total }, (_, i) => ({ number: i + 1 }))
        .filter(
          (c) =>
            (gt === undefined || c.number > gt) &&
            (gte === undefined || c.number >= gte) &&
            (lte === undefined || c.number <= lte),
        )
        .slice(0, args.take),
    );
  };
  return { db: { chapter: { findMany } } as unknown as Prisma.TransactionClient, calls };
};

describe('chapterPages', () => {
  it('reads every chapter by pages with a page limit, past 2000 chapters', async () => {
    const { db, calls } = fakeDb(2_001);
    const all = await allChapters(db, 'v1', { number: true });
    expect(all).toHaveLength(2_001);
    expect(all[2_000].number).toBe(2_001);
    expect(new Set(calls.map((c) => c.take))).toEqual(new Set([CHAPTER_PAGE_SIZE]));
    // Курсор - номер последней главы прошлой страницы, порядок - по номеру.
    expect(calls[1].where.number.gt).toBe(CHAPTER_PAGE_SIZE);
    expect(calls.every((c) => c.orderBy.number === 'asc' && c.where.bookVersionId === 'v1')).toBe(
      true,
    );
  });

  it('an exact multiple of the page ends with one empty read, no page is lost', async () => {
    const { db } = fakeDb(2 * CHAPTER_PAGE_SIZE);
    const sizes: number[] = [];
    for await (const page of chapterPages(db, 'v1', { number: true })) sizes.push(page.length);
    expect(sizes).toEqual([CHAPTER_PAGE_SIZE, CHAPTER_PAGE_SIZE]);
  });

  it('reads only the asked range of numbers', async () => {
    const { db } = fakeDb(500);
    const range = await allChapters(db, 'v1', { number: true }, { from: 150, to: 320 });
    expect(range.map((c) => c.number)).toEqual(Array.from({ length: 171 }, (_, i) => i + 150));
  });

  it('a source without chapters yields nothing', async () => {
    const { db } = fakeDb(0);
    expect(await allChapters(db, 'v1', { number: true })).toEqual([]);
  });
});
