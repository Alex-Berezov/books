import { Prisma } from '@prisma/client';

/** Глав в одной выборке: потолок страницы (правило `books`), а не размер книги. */
export const CHAPTER_PAGE_SIZE = 100;

/** Поля главы, которые читают страницами; номер нужен всегда - по нему идёт курсор. */
export type ChapterPageSelect = Prisma.ChapterSelect & { number: true };

export type ChapterPageRow<S extends ChapterPageSelect> = Prisma.ChapterGetPayload<{ select: S }>;

/**
 * Главы версии страницами по номеру (`F05-Rb`): выборка без потолка не пишется, а потолок на
 * число глав книгу обрывал. Курсор - номер последней главы страницы, порядок - по номеру; правило
 * страниц живёт здесь одно, вызывающий даёт только поля и, если нужно, диапазон номеров.
 */
export async function* chapterPages<S extends ChapterPageSelect>(
  db: Prisma.TransactionClient,
  versionId: string,
  select: S,
  options: { from?: number; to?: number } = {},
): AsyncGenerator<Array<ChapterPageRow<S>>> {
  let after: number | null = null;
  for (;;) {
    const page = (await db.chapter.findMany({
      where: {
        bookVersionId: versionId,
        number: {
          ...(after === null ? { gte: options.from } : { gt: after }),
          lte: options.to,
        },
      },
      select,
      orderBy: { number: 'asc' },
      take: CHAPTER_PAGE_SIZE,
    })) as Array<ChapterPageRow<S>>;
    if (page.length === 0) return;
    yield page;
    if (page.length < CHAPTER_PAGE_SIZE) return;
    after = (page[page.length - 1] as { number: number }).number;
  }
}

/** Все главы одним списком - для мест, где в памяти нужны все (названия глав). */
export async function allChapters<S extends ChapterPageSelect>(
  db: Prisma.TransactionClient,
  versionId: string,
  select: S,
  options: { from?: number; to?: number } = {},
): Promise<Array<ChapterPageRow<S>>> {
  const all: Array<ChapterPageRow<S>> = [];
  for await (const page of chapterPages(db, versionId, select, options)) all.push(...page);
  return all;
}
