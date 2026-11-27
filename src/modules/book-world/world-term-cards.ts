import { Prisma } from '@prisma/client';
import { toTermCard, WORLD_TERM_CARD_SELECT } from './book-world-data';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import type { BookWorldTermCardDto } from './dto/book-world-response.dto';
import { WORLD_OBJECTS, worldCardShown } from './world-public';

/**
 * Порядок глоссария (решение арбитра `F08 | F08-13` Q7): по первой главе, без главы — в конце,
 * при равенстве — по ключу кодом символа (без локали).
 */
export function byFirstChapter(
  a: { chapter: number | null; key: string },
  b: { chapter: number | null; key: string },
): number {
  if (a.chapter !== b.chapter) {
    if (a.chapter === null) return 1;
    if (b.chapter === null) return -1;
    return a.chapter - b.chapter;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Глоссарий общей страницы: понятия, и без своей страницы (`product.md` §7). Условие показа —
 * `worldCardShown`, единственная копия; выключенный рубильник `WORLD_OBJECTS` — пустой список без
 * запроса.
 */
export async function worldTermCards(
  prisma: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
): Promise<BookWorldTermCardDto[]> {
  if (!WORLD_OBJECTS.public) return [];
  const rows = await prisma.bookWorldEntity.findMany({
    where: { bookVersionId, type: 'term' },
    select: WORLD_TERM_CARD_SELECT,
    orderBy: { key: 'asc' },
    take: BOOK_WORLD_LIMITS.entities,
  });
  return rows.filter(worldCardShown).map(toTermCard).sort(byFirstChapter);
}
