import { Prisma, PublicationStatus } from '@prisma/client';
import { stableJson } from '../../shared/json/stable-json';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { mentionChapters } from './world-core';
import { pairMembers } from './world-refs';

/**
 * Порог присутствия второстепенного героя (`product.md` §2): страница — при ядре и не меньше чем
 * в стольких главах. Стартовое значение; калибруется пачкой второстепенных героев (`F08-8`).
 */
export const WORLD_MIN_CHAPTERS = 3;

/**
 * Рубильник публичности пар (решение арбитра `F08 | F08-8c-1` R2): пока страницы пары нет на фронте
 * (`F08-8c-2`), пара на сайт не выходит — ни в список, ни в карту сайта, ни в hreflang. `F08-8c-2`
 * включает его тегом бэкенда вместе с пересчётом `isListed` пар. Объект, а не константа: e2e
 * проверяют оба положения в одном процессе.
 */
export const WORLD_PAIRS = { public: false };

export interface WorldListedInput {
  /** Тип сущности; нет — герой. */
  type?: string;
  /**
   * Пара (`F08-8c`): оба героя ключа `isListed` — `pairMembersIn`; у героя не читается.
   * Нет значения у пары — не публична.
   */
  hasListedMembers?: boolean;
  role: string | null;
  hasCore: boolean;
  isVisible: boolean;
  readAt: Date | null;
  autoTextAt: Date | null;
  mentions: unknown;
}

/**
 * Роль и присутствие (`product.md` §2): `main` проходит при любом числе глав, `secondary` - от
 * `WORLD_MIN_CHAPTERS` глав, `minor` и без роли - никогда. Единственная копия условия: его
 * читают публичность (`computeWorldListed`) и отбор кандидатов хода мира (`F08-8b`).
 */
export function worldRolePasses(role: string | null, chapters: number): boolean {
  if (role === 'main') return true;
  if (role === 'secondary') return chapters >= WORLD_MIN_CHAPTERS;
  return false;
}

/**
 * Публичность сущности без версии (решения арбитра `F08 | F08-1` R1 и PM-3): ядро, «показывать»,
 * «прочитано» не раньше последнего текста модели (или текста модели нет); роль и главы —
 * `worldRolePasses`. Пишется столбцом
 * `isListed` только этой функцией (через `worldListedWrite`), в каждой транзакции записи; второй
 * копии условия нет нигде — выборки читают `WORLD_ENTITY_PUBLIC_WHERE`.
 */
export function computeWorldListed(e: WorldListedInput): boolean {
  if (!e.hasCore || !e.isVisible) return false;
  if (e.autoTextAt && (!e.readAt || e.readAt.getTime() < e.autoTextAt.getTime())) return false;
  // Пара (решение арбитра `F08 | F08-8c` Q3): роли нет, вместо роли — оба героя ключа на сайте.
  if (e.type === 'pair') return WORLD_PAIRS.public && e.hasListedMembers === true;
  return worldRolePasses(e.role, mentionChapters(e.mentions).length);
}

/**
 * Оба героя пары на сайте (решение арбитра `F08 | F08-8c` Q3) — единственная копия условия:
 * ключ разбирается в героев, оба в наборе героев версии с `isListed` (`listedCharacterKeys`).
 * Не ключ пары — `false`.
 */
export function pairMembersIn(key: string, listedCharacters: ReadonlySet<string>): boolean {
  const members = pairMembers(key);
  return members !== null && members.every((k) => listedCharacters.has(k));
}

/** Герои версии с `isListed` — одним запросом, вход `pairMembersIn` для всех пар версии. */
export async function listedCharacterKeys(
  tx: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
): Promise<Set<string>> {
  const rows = await tx.bookWorldEntity.findMany({
    where: { bookVersionId, type: 'character', isListed: true },
    select: { key: true },
    take: BOOK_WORLD_LIMITS.entities,
  });
  return new Set(rows.map((r) => r.key));
}

/**
 * Порядок записи сущностей версии: герои раньше пар — публичность пары читает `isListed` героев,
 * уже записанный в этой транзакции (Q3). Один порядок на запись тела и на пересчёт присутствия.
 */
export const heroesFirst = (x: { type: string }, y: { type: string }) =>
  Number(x.type === 'pair') - Number(y.type === 'pair');

/** Сущность на сайте: версия опубликована и `isListed` (`tech.md` §2). */
export function isWorldEntityPublic(
  entity: { isListed: boolean },
  version: { status: PublicationStatus },
): boolean {
  return version.status === 'published' && entity.isListed;
}

/**
 * Единственное условие выборок публичных сущностей: `_count.worldEntities`, `worldKeys` обзора,
 * публичные `GET`. Версия в них уже опубликована: обзор и карточки читают только опубликованные
 * версии, ручки отвечают 404 на черновик не редактору.
 */
export const WORLD_ENTITY_PUBLIC_WHERE = {
  isListed: true,
} as const satisfies Prisma.BookWorldEntityWhereInput;

/**
 * То же условие для сырого `UPDATE` публикации версии (`book-version.service.ts`): ставить
 * `firstPublishedAt` без сдвига `updatedAt` (его сдвигает Prisma на `updateMany`). Совпадение с
 * `WORLD_ENTITY_PUBLIC_WHERE` держит `world-public.spec.ts`.
 */
export const WORLD_ENTITY_PUBLIC_SQL = Prisma.sql`"isListed" = true`;

/**
 * `firstPublishedAt` сущностям версии, которые на сайте с этой публикацией: сырой запрос, чтобы
 * отметка первого показа не выглядела правкой сущности (`updatedAt` — сверка вкладки, R6).
 * Время — `NOW() AT TIME ZONE 'UTC'`: колонка `TIMESTAMP(3)` без зоны, Prisma пишет её в UTC, а
 * `Date` параметром сырого запроса Postgres переводил бы по зоне сессии.
 * Зовётся клиентом транзакции публикации; число обновлённых строк.
 */
export function stampWorldFirstPublished(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  bookVersionId: string,
): Promise<number> {
  return tx.$executeRaw`UPDATE "BookWorldEntity" SET "firstPublishedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "bookVersionId" = ${bookVersionId} AND ${WORLD_ENTITY_PUBLIC_SQL} AND "firstPublishedAt" IS NULL`;
}

/**
 * Поля записи по публичности — в каждой транзакции записи сущности: `isListed` по
 * `computeWorldListed`; `firstPublishedAt` ставится, когда сущность впервые на сайте
 * (`isListed` при опубликованной версии), и не сбрасывается никогда (решение арбитра R2).
 */
export function worldListedWrite(
  next: WorldListedInput & { firstPublishedAt: Date | null },
  version: { status: PublicationStatus },
  now: Date,
): { isListed: boolean; firstPublishedAt?: Date } {
  const isListed = computeWorldListed(next);
  if (next.firstPublishedAt === null && isWorldEntityPublic({ isListed }, version)) {
    return { isListed, firstPublishedAt: now };
  }
  return { isListed };
}

/**
 * Производные поля записи не изменились — одно условие на запись сущности и пересчёт
 * присутствия (F08-2): ядро, чего не хватает, `isListed`; `firstPublishedAt` ставить не нужно.
 */
export function worldDerivedUnchanged(
  existing: { hasCore: boolean; coreMissing: string[]; isListed: boolean },
  next: { hasCore: boolean; coreMissing: string[] },
  listed: { isListed: boolean; firstPublishedAt?: Date },
): boolean {
  return (
    existing.hasCore === next.hasCore &&
    stableJson(existing.coreMissing) === stableJson(next.coreMissing) &&
    existing.isListed === listed.isListed &&
    listed.firstPublishedAt === undefined
  );
}

/** Оба героя пары на сайте — `undefined` у героя (у него не читается). */
export type WorldMembersReader = (entity: {
  key: string;
  type: string;
}) => Promise<boolean | undefined>;

/**
 * Чтение «оба героя пары на сайте» на одну транзакцию записи (Q3): набор героев с `isListed`
 * читается одним запросом при первой паре — герои к этому моменту уже записаны (`heroesFirst`),
 * — и служит всем парам транзакции. Один на запись тела, запись сущности, отметки и пересчёт.
 */
export function worldMembersReader(
  tx: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
): WorldMembersReader {
  let heroes: Promise<Set<string>> | null = null;
  return async (entity) => {
    if (entity.type !== 'pair') return undefined;
    heroes ??= listedCharacterKeys(tx, bookVersionId);
    return pairMembersIn(entity.key, await heroes);
  };
}

/**
 * Пары версии после героев (решение арбитра `F08 | F08-8c` Q3): в той же транзакции, где у героя
 * мог смениться `isListed` (запись, «прочитано», флаги, пересчёт присутствия), `isListed` пар
 * пересчитывается тем же `worldListedWrite`. Пишутся только пары, у которых он изменился, с прежним
 * `updatedAt` (как отметки, R6). Число записанных пар.
 */
export async function relistWorldPairs(
  tx: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
  version: { status: PublicationStatus },
  now: Date,
): Promise<number> {
  const pairs = await tx.bookWorldEntity.findMany({
    where: { bookVersionId, type: 'pair' },
    select: {
      key: true,
      type: true,
      role: true,
      hasCore: true,
      isVisible: true,
      readAt: true,
      autoTextAt: true,
      mentions: true,
      isListed: true,
      firstPublishedAt: true,
      updatedAt: true,
    },
    orderBy: { key: 'asc' },
    take: BOOK_WORLD_LIMITS.entities,
  });
  if (pairs.length === 0) return 0;
  const listedCharacters = await listedCharacterKeys(tx, bookVersionId);
  let written = 0;
  for (const pair of pairs) {
    const hasListedMembers = pairMembersIn(pair.key, listedCharacters);
    const listed = worldListedWrite({ ...pair, hasListedMembers }, version, now);
    if (pair.isListed === listed.isListed && listed.firstPublishedAt === undefined) continue;
    await tx.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId, key: pair.key } },
      data: { ...listed, updatedAt: pair.updatedAt },
    });
    written++;
  }
  return written;
}
