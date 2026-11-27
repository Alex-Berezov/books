import { Prisma, PublicationStatus } from '@prisma/client';
import { stableJson } from '../../shared/json/stable-json';
import { BOOK_WORLD_LIMITS, isWorldObjectType } from './dto/book-world-blocks.dto';
import { mentionChapters } from './world-core';
import { pairMembers } from './world-refs';

/**
 * Порог присутствия второстепенного героя (`product.md` §2): страница — при ядре и не меньше чем
 * в стольких главах. Стартовое значение; калибруется пачкой второстепенных героев (`F08-8`).
 */
export const WORLD_MIN_CHAPTERS = 3;

/**
 * Рубильник публичности пар (решение арбитра `F08 | F08-8c-1` R2): выключенный, он держал пару вне
 * сайта — списка, карты сайта и hreflang — пока страницы пары нет на фронте. `F08-8c-2` включила его
 * тегом бэкенда. Пересчёта `isListed` пар не требуется: пары заводит только редактор, а пока
 * рубильник был выключен, пару не публиковал ни один путь записи (`computeWorldListed` давал false),
 * а пересчитывает пары запись, «прочитано» или флаги самой пары и смена `isListed` её героя
 * (`relistWorldPairs`); пару, которую никто не тронул, выводит на сайт первое такое событие. Объект, а не
 * константа: e2e проверяют оба положения в одном процессе. Без разового пересчёта — решение арбитра
 * `F08 | F08-8c-2` (20.11.2026, `decisions-log.md`).
 */
export const WORLD_PAIRS = { public: true };

/**
 * Рубильник публичности мест (решение арбитра `F08 | F08-12` Q0, по образцу `WORLD_PAIRS`):
 * выключенный, он держит место вне сайта — списка, карточки `/wiki`, карты сайта и hreflang.
 * Включён пачкой `F08-12c` вместе со страницей места на фронте; места, записанные при выключенном,
 * вывел на сайт разовый пересчёт при старте (решение `F08 | F08-12a` R4, снят в `F08-12d`).
 * Объект, а не константа: e2e проверяют оба положения в одном процессе.
 */
export const WORLD_PLACES = { public: true };

/**
 * Рубильник публичности предмета, понятия и события (`F08-13a`, решение арбитра `F08 | F08-13` Q6):
 * один на три типа. Выключенный, он держит их вне сайта — списка, глоссария `/wiki`, карты сайта
 * и hreflang, — пока их страниц нет на фронте (старый фронт рисует любой новый тип шаблоном героя).
 * Включается тегом бэкенда в `F08-13c` после фронта, с разовым пересчётом `isListed`.
 * Объект, а не константа: e2e проверяют оба положения в одном процессе.
 */
export const WORLD_OBJECTS = { public: false };

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
  if (!readAfterAutoText(e)) return false;
  // Пара (решение арбитра `F08 | F08-8c` Q3): роли нет, вместо роли — оба героя ключа на сайте.
  if (e.type === 'pair') return WORLD_PAIRS.public && e.hasListedMembers === true;
  // Место (решение арбитра `F08 | F08-12` Q1): роли нет, страница — по ядру без порога ролей.
  if (e.type === 'place') return WORLD_PLACES.public;
  // Предмет, понятие, событие (решение арбитра `F08 | F08-13` Q1, Q6): роли нет, страница — по ядру.
  if (isWorldObjectType(e.type)) return WORLD_OBJECTS.public;
  return worldRolePasses(e.role, mentionChapters(e.mentions).length);
}

/**
 * «Прочитано» не раньше последнего текста модели (или текста модели нет, решение арбитра
 * `F08 | F08-1` R5, `T184`) — одна копия условия на публичность страницы и карточку места.
 */
function readAfterAutoText(e: { readAt: Date | null; autoTextAt: Date | null }): boolean {
  return !e.autoTextAt || (e.readAt !== null && e.readAt.getTime() >= e.autoTextAt.getTime());
}

/**
 * Карточка без своей страницы на общей странице `/wiki`: место (решение арбитра `F08 | F08-12` Q4)
 * текстовым списком и точкой на карте, понятие (`F08-13a`, решение `F08 | F08-13` Q6) строкой
 * глоссария (`product.md` §2, §7: без адреса). Условие: рубильник типа, «показывать», «прочитано»
 * не раньше текста модели; ядро не нужно — оно даёт только страницу (`isListed`). Опубликованность
 * версии — условие самой ручки (404 на черновик не редактору). Единственная копия: списки читателя
 * (`worldPlaceCards`, `worldTermCards`) другой не держат. Карточка не даёт адреса, не идёт в карту
 * сайта и hreflang. Другие типы — `false`.
 */
export function worldCardShown(e: {
  type: string;
  isVisible: boolean;
  readAt: Date | null;
  autoTextAt: Date | null;
}): boolean {
  const switchedOn =
    (e.type === 'place' && WORLD_PLACES.public) || (e.type === 'term' && WORLD_OBJECTS.public);
  return switchedOn && e.isVisible && readAfterAutoText(e);
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
 * Поля пересчёта `isListed` пар (`relistWorldPairs`): вход `worldListedWrite` и прежний `updatedAt`.
 * Одна копия: новое поле `WorldListedInput` добавляется сюда.
 */
const WORLD_RELIST_SELECT = {
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
} as const satisfies Prisma.BookWorldEntitySelect;

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
    select: WORLD_RELIST_SELECT,
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
