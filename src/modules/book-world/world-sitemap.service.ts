import { Injectable } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginatedResult } from '../../shared/dto/paginated-response.dto';
import { noindexSeoIds } from '../../shared/seo/noindex-seo';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import type { WorldSitemapItemDto } from './dto/world-sitemap.dto';
import {
  VERSIONS_PER_BOOK,
  openVersionWhere,
  worldCluster,
  worldSiblings,
  type WorldSibling,
} from './world-alternates';
import { WORLD_ENTITY_PUBLIC_WHERE } from './world-public';

/** Версии, у которых есть мир на сайте: только они попадают в карту и в кластеры. */
const HAS_WORLD = { worldEntities: { some: WORLD_ENTITY_PUBLIC_WHERE } } as const;

/**
 * Карта сайта мира книги (F08-3, решения арбитра `F08 | F08-3` Q1, Q4, Q10, Q12): страница — опубликованные
 * версии языка со слагом, хоть одной публичной сущностью и без редакторского `noindex`. Общая страница
 * `/wiki` идёт всегда, сущности — только `isIndexable`. Кластер языков — `worldCluster`, тот же, что
 * у ответов страниц (`world-alternates.ts`): карта и hreflang страниц не расходятся.
 */
@Injectable()
export class WorldSitemapService {
  constructor(private readonly prisma: PrismaService) {}

  async sitemap(
    language: Language,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<WorldSitemapItemDto>> {
    // Одна выборка `noindex` на страницу карты — только версий с миром на сайте (других в карте и
    // в кластерах нет): потолок `SITEMAP_NOINDEX_SEO_LIMIT` не делится со всем каталогом.
    const noindex = await noindexSeoIds(this.prisma, { status: 'published', ...HAS_WORLD });
    // Все фильтры — одним `where` для страницы и `total` (короткая страница при полном `total` —
    // отказ `readCompletePage` на фронте, как у карты разделов).
    const where: Prisma.BookVersionWhereInput = {
      AND: [{ language, ...HAS_WORLD }, openVersionWhere(noindex)],
    };
    const [rows, total] = await Promise.all([
      this.prisma.bookVersion.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          bookId: true,
          worldEntities: {
            where: WORLD_ENTITY_PUBLIC_WHERE,
            orderBy: { key: 'asc' },
            take: BOOK_WORLD_LIMITS.entities,
            select: { key: true, isIndexable: true, updatedAt: true },
          },
        },
      }),
      this.prisma.bookVersion.count({ where }),
    ]);
    const bookIds = [...new Set(rows.map((r) => r.bookId))];
    const siblings =
      bookIds.length === 0
        ? []
        : await worldSiblings(
            this.prisma,
            { bookId: { in: bookIds }, ...HAS_WORLD },
            bookIds.length * VERSIONS_PER_BOOK,
            noindex,
          );
    const byBook = new Map<string, WorldSibling[]>();
    for (const s of siblings) byBook.set(s.bookId, [...(byBook.get(s.bookId) ?? []), s]);
    const items = rows.flatMap((row): WorldSitemapItemDto[] => {
      const own = byBook.get(row.bookId) ?? [];
      const slug = own.find((s) => s.id === row.id)?.slug;
      if (!slug || row.worldEntities.length === 0) return [];
      return [
        {
          slug,
          lastmod: new Date(Math.max(...row.worldEntities.map((e) => e.updatedAt.getTime()))),
          alternates: worldCluster(row.id, own),
          entities: row.worldEntities
            .filter((e) => e.isIndexable)
            .map((e) => ({
              key: e.key,
              lastmod: e.updatedAt,
              alternates: worldCluster(row.id, own, e.key),
            })),
        },
      ];
    });
    return paginated(items, { page, limit, total });
  }
}
