import { Prisma } from '@prisma/client';
import {
  toObjectCard,
  WORLD_EVENT_CARD_SELECT,
  WORLD_OBJECT_CARD_SELECT,
  type WorldEventCardRow,
  type WorldObjectCardRow,
} from './book-world-data';
import {
  BOOK_WORLD_LIMITS,
  WORLD_OBJECT_TYPES,
  type WorldObjectType,
} from './dto/book-world-blocks.dto';
import type { BookWorldObjectCardDto } from './dto/book-world-response.dto';
import { WORLD_OBJECTS, worldCardShown } from './world-public';

/**
 * Порядок карточек (решение арбитра `F08 | F08-13` Q7): по первой главе, без главы — в конце,
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
 * Типы карточек без сцен — все из `WORLD_OBJECT_TYPES`, кроме события: его глава считается по
 * сценам (`WORLD_EVENT_CARD_SELECT`). Один перечень с рубильником и пересчётом.
 */
const PLAIN_CARD_TYPES = WORLD_OBJECT_TYPES.filter((t) => t !== 'event');

/** Карточки общей страницы по типам: предметы, глоссарий понятий, события. */
export interface WorldObjectCards {
  objects: BookWorldObjectCardDto[];
  terms: BookWorldObjectCardDto[];
  events: BookWorldObjectCardDto[];
}

/**
 * Карточки предметов, понятий и событий общей страницы, и без своей страницы (`product.md` §2, §7;
 * решения арбитра `F08 | F08-13c` Q2, Q3): понятия — глоссарием, предметы и события — списками.
 * Условие показа — `worldCardShown`, единственная копия; выключенный рубильник `WORLD_OBJECTS` —
 * пустые списки без запроса. События читаются отдельно: их главе нужны сцены
 * (`WORLD_EVENT_CARD_SELECT`), а предметам и понятиям тянуть `blocks` незачем.
 */
export async function worldObjectCards(
  prisma: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
): Promise<WorldObjectCards> {
  if (!WORLD_OBJECTS.public) return { objects: [], terms: [], events: [] };
  const [plain, events] = await Promise.all([
    prisma.bookWorldEntity.findMany({
      where: { bookVersionId, type: { in: [...PLAIN_CARD_TYPES] } },
      select: WORLD_OBJECT_CARD_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    }),
    prisma.bookWorldEntity.findMany({
      where: { bookVersionId, type: 'event' },
      select: WORLD_EVENT_CARD_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    }),
  ]);
  const cards = (type: WorldObjectType) => {
    const rows: readonly (WorldObjectCardRow | WorldEventCardRow)[] =
      type === 'event' ? events : plain.filter((r) => r.type === type);
    return rows.filter(worldCardShown).map(toObjectCard).sort(byFirstChapter);
  };
  return { objects: cards('object'), terms: cards('term'), events: cards('event') };
}
