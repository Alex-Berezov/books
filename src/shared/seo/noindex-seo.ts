import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { robotsHasNoindex } from './term-indexable.util';

/**
 * Предел выборки `Seo` с `noindex` (решение арбитра `F04 | F04-1`, шаг 7 после круга 3): кандидаты
 * собираются в память, поэтому с ограничением строк; дошли до него — 503, а не урезанный список,
 * который открыл бы закрытые от индекса книги.
 */
export const SITEMAP_NOINDEX_SEO_LIMIT = 10_000;

/**
 * `Seo` версий, закрытых редактором от индекса: кандидаты по подстроке, отбор — общим разборщиком
 * `robotsHasNoindex` (решение арбитра `F04 | F04-1`, п.4). Одно правило на карты разделов пересказа
 * и мира книги (решение арбитра `F08 | F08-3` Q4); `versions` — какие версии смотреть.
 */
export async function noindexSeoIds(
  db: Pick<PrismaClient, 'seo'>,
  versions: Prisma.BookVersionWhereInput,
): Promise<number[]> {
  const candidates = await db.seo.findMany({
    where: {
      bookVersion: versions,
      OR: [
        { robots: { contains: 'noindex', mode: 'insensitive' } },
        { robots: { contains: 'none', mode: 'insensitive' } },
      ],
    },
    select: { id: true, robots: true },
    orderBy: { id: 'asc' },
    take: SITEMAP_NOINDEX_SEO_LIMIT + 1,
  });
  if (candidates.length > SITEMAP_NOINDEX_SEO_LIMIT) {
    throw new ServiceUnavailableException('Too many noindex pages to build the sitemap');
  }
  return candidates.filter((seo) => robotsHasNoindex(seo.robots)).map((seo) => seo.id);
}

/**
 * Условие «версия не закрыта от индекса» для `where` выборки. `notIn` по nullable-полю отбрасывает
 * строки с `NULL`, поэтому версия без `Seo` проходит отдельной веткой.
 */
export function notNoindexWhere(ids: number[]): Prisma.BookVersionWhereInput {
  return ids.length > 0 ? { OR: [{ seoId: null }, { seoId: { notIn: ids } }] } : {};
}
