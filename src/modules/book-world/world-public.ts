import { Prisma, PublicationStatus } from '@prisma/client';
import { stableJson } from '../../shared/json/stable-json';
import { mentionChapters } from './world-core';

/**
 * Порог присутствия второстепенного героя (`product.md` §2): страница — при ядре и не меньше чем
 * в стольких главах. Стартовое значение; калибруется пачкой второстепенных героев (`F08-8`).
 */
export const WORLD_MIN_CHAPTERS = 3;

export interface WorldListedInput {
  role: string | null;
  hasCore: boolean;
  isVisible: boolean;
  readAt: Date | null;
  autoTextAt: Date | null;
  mentions: unknown;
}

/**
 * Публичность сущности без версии (решения арбитра `F08 | F08-1` R1 и PM-3): ядро, «показывать»,
 * «прочитано» не раньше последнего текста модели (или текста модели нет); `main` — этого
 * достаточно, `secondary` — ещё порог глав, `minor` и без роли — никогда. Пишется столбцом
 * `isListed` только этой функцией (через `worldListedWrite`), в каждой транзакции записи; второй
 * копии условия нет нигде — выборки читают `WORLD_ENTITY_PUBLIC_WHERE`.
 */
export function computeWorldListed(e: WorldListedInput): boolean {
  if (!e.hasCore || !e.isVisible) return false;
  if (e.autoTextAt && (!e.readAt || e.readAt.getTime() < e.autoTextAt.getTime())) return false;
  if (e.role === 'main') return true;
  if (e.role === 'secondary') return mentionChapters(e.mentions).length >= WORLD_MIN_CHAPTERS;
  return false;
}

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
