import { Prisma } from '@prisma/client';
import { toPlaceCard, WORLD_PLACE_CARD_SELECT } from './book-world-data';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import type { BookWorldPlaceCardDto } from './dto/book-world-response.dto';
import { WORLD_PLACES, worldPlaceShown } from './world-public';

/**
 * Места общей страницы (решение арбитра `F08 | F08-12` Q4): условие показа — `worldPlaceShown`,
 * единственная копия; выключенный рубильник мест — пустой список без запроса.
 */
export async function worldPlaceCards(
  prisma: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
): Promise<BookWorldPlaceCardDto[]> {
  if (!WORLD_PLACES.public) return [];
  const rows = await prisma.bookWorldEntity.findMany({
    where: { bookVersionId, type: 'place' },
    select: WORLD_PLACE_CARD_SELECT,
    orderBy: { key: 'asc' },
    take: BOOK_WORLD_LIMITS.entities,
  });
  return rows.filter(worldPlaceShown).map(toPlaceCard);
}
