import { Language, Prisma, type PrismaClient } from '@prisma/client';
import { noindexSeoIds, notNoindexWhere } from '../../shared/seo/noindex-seo';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import type { WorldAlternateDto } from './dto/book-world-response.dto';
import { WORLD_ENTITY_PUBLIC_WHERE } from './world-public';

/**
 * Кластер языков мира книги (решения арбитра `F08 | F08-3` Q1, Q4 и `F08 | F08-3a` «hreflang
 * страниц»): одно правило на карту сайта и на ответы страниц, своих копий нет нигде. Язык в кластере —
 * опубликованная версия той же книги со слагом, без редакторского `noindex`; у общей страницы — хоть
 * одна публичная сущность, у сущности — тот же ключ публичен и `isIndexable`. Смена правила — тема №3.
 */

/**
 * Версий одной книги не больше числа языков: `@@unique([bookId, language])` у `BookVersion`. Потолок
 * выборки соседей — ровно столько на книгу, обрезать нечего.
 */
export const VERSIONS_PER_BOOK = Object.keys(Language).length;

export type WorldSibling = {
  id: string;
  bookId: string;
  language: Language;
  slug: string | null;
  worldEntities: { key: string; isIndexable: boolean }[];
};

type Db = Pick<PrismaClient, 'seo' | 'bookVersion'>;

/** Опубликованная версия со слагом, не закрытая редактором от индекса. */
export const openVersionWhere = (noindex: number[]): Prisma.BookVersionWhereInput => ({
  AND: [{ status: 'published', slug: { not: null } }, notNoindexWhere(noindex)],
});

const SIBLING_SELECT = {
  id: true,
  bookId: true,
  language: true,
  slug: true,
  worldEntities: {
    where: WORLD_ENTITY_PUBLIC_WHERE,
    take: BOOK_WORLD_LIMITS.entities,
    select: { key: true, isIndexable: true },
  },
} as const satisfies Prisma.BookVersionSelect;

/** Открытые версии книг (`books`) на всех языках — одним запросом; `noindex` — их же выборка. */
export function worldSiblings(
  db: Db,
  books: Prisma.BookVersionWhereInput,
  limit: number,
  noindex: number[],
): Promise<WorldSibling[]> {
  return db.bookVersion.findMany({
    where: { AND: [books, openVersionWhere(noindex)] },
    orderBy: { id: 'asc' },
    take: limit,
    select: SIBLING_SELECT,
  });
}

/**
 * Индексируемые ключи версии — множеством, раз на объект: карта зовёт кластер на каждую сущность
 * страницы, и перебор списков соседей был бы квадратичным.
 */
const indexableCache = new WeakMap<WorldSibling, Set<string>>();
function indexableKeys(s: WorldSibling): Set<string> {
  let keys = indexableCache.get(s);
  if (!keys) {
    keys = new Set(s.worldEntities.filter((x) => x.isIndexable).map((x) => x.key));
    indexableCache.set(s, keys);
  }
  return keys;
}

/** Кластер общей страницы `/wiki` (`key` нет) или сущности: по языку одна версия, своя первой. */
export function worldCluster(
  selfId: string,
  siblings: readonly WorldSibling[],
  key?: string,
): WorldAlternateDto[] {
  const self = siblings.find((s) => s.id === selfId);
  if (!self) return [];
  const has = (s: WorldSibling) =>
    key === undefined ? s.worldEntities.length > 0 : indexableKeys(s).has(key);
  if (!has(self)) return [];
  const byLang = new Map<Language, WorldAlternateDto>();
  for (const s of [self, ...siblings.filter((x) => x.id !== selfId)]) {
    if (!s.slug || byLang.has(s.language) || !has(s)) continue;
    byLang.set(s.language, { language: s.language, slug: s.slug });
  }
  return [...byLang.values()];
}

/**
 * Кластер страницы версии для ответа ручки: два запроса (`noindex` и соседи книги) параллельно.
 * Версия не опубликована, без слага, под `noindex`, сущность не публична или не индексируется —
 * пустой список; «кластер без себя» решает фронт (`ownClusterOrNone`).
 */
export async function worldAlternates(
  db: Db,
  bookVersionId: string,
  key?: string,
): Promise<WorldAlternateDto[]> {
  const sameBook: Prisma.BookVersionWhereInput = {
    book: { versions: { some: { id: bookVersionId } } },
  };
  const noindex = await noindexSeoIds(db, { AND: [sameBook, { status: 'published' }] });
  const siblings = await worldSiblings(db, sameBook, VERSIONS_PER_BOOK, noindex);
  return worldCluster(bookVersionId, siblings, key);
}
