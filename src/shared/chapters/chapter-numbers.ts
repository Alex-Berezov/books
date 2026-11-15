import type { Prisma } from '@prisma/client';

/**
 * Предел выборки номеров глав (`chapterNumbers`): тот же, что у списка названий глав админки
 * (`chapter-titles`, 5 000). Выборка целиком в память идёт с ограничением строк.
 */
export const CHAPTER_NUMBERS_LIMIT = 5000;

/**
 * Номера глав версии — чтобы страница ставила ссылку «глава N» только на существующую главу
 * (анализ: `product.md` §1.6, решение арбитра `F03 | F03-2`; мир книги: F08 `product.md` §1 п.7).
 * Только `number`: ни заголовков, ни текста. Одна функция на анализ и мир книги.
 */
export async function loadChapterNumbers(
  client: Pick<Prisma.TransactionClient, 'chapter'>,
  bookVersionId: string,
): Promise<number[]> {
  const chapters = await client.chapter.findMany({
    where: { bookVersionId },
    select: { number: true },
    orderBy: { number: 'asc' },
    take: CHAPTER_NUMBERS_LIMIT,
  });
  return chapters.map((chapter) => chapter.number);
}
