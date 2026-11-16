import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type WorldStatEvent } from '@prisma/client';
import { isBotUserAgent } from '../../shared/http/bot-user-agent';
import { PrismaService } from '../../prisma/prisma.service';
import { WORLD_ENTITY_PUBLIC_WHERE } from './world-public';
import { openVersionWhere } from './world-alternates';
import {
  WORLD_STATS_DEFAULT_DAYS,
  type WorldBeaconDto,
  type WorldStatsResponseDto,
} from './dto/world-stats.dto';

/** Строк отчёта за раз: сущностей в версии до 100, событий семь — запас на десяток версий. */
export const WORLD_STATS_ROW_LIMIT = 10_000;

/** Сутки события по UTC — день агрегата. */
const utcDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * +1 к строке дня одним оператором: `INSERT … ON CONFLICT DO UPDATE` атомарен под уникальным ключом.
 * `upsert` Prisma на одновременных первых событиях дня мог читать «строки нет» дважды и второй
 * вставкой ловить P2002 — 500 и потерянное событие. День — строкой `YYYY-MM-DD` в `::date`: сутки
 * UTC без перевода по зоне сессии.
 */
export function worldStatIncrementSql(
  bookVersionId: string,
  key: string,
  event: WorldStatEvent,
  now: Date,
): Prisma.Sql {
  return Prisma.sql`INSERT INTO "WorldDailyStat" ("id", "day", "bookVersionId", "key", "event", "count")
    VALUES (${randomUUID()}, ${isoDay(utcDay(now))}::date, ${bookVersionId}, ${key}, ${event}::"WorldStatEvent", 1)
    ON CONFLICT ("day", "bookVersionId", "key", "event")
    DO UPDATE SET "count" = "WorldDailyStat"."count" + 1`;
}

/**
 * Счётчики публичных страниц мира книги (F08-3, `product.md` §14; решение арбитра `F08 | F08-3` Q5):
 * агрегат по дням `{day, bookVersionId, key, event, count}`, без IP, пользователя и cookie.
 */
@Injectable()
export class WorldStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Событие (лимит по адресу — `WorldBeaconRateLimitGuard` до сервиса): бот — без записи; страницы
   * нет (версия не опубликована, сущность не публична или у версии нет публичных сущностей) — 404;
   * иначе +1 к строке дня.
   */
  async record(dto: WorldBeaconDto, userAgent: string | undefined): Promise<void> {
    if (isBotUserAgent(userAgent)) return;
    await this.assertPublicPage(dto.bookVersionId, dto.key);
    await this.prisma.$executeRaw(
      worldStatIncrementSql(dto.bookVersionId, dto.key ?? '', dto.event, new Date()),
    );
  }

  /** Страница существует для читателя: опубликованная версия и публичная сущность (или хоть одна). */
  private async assertPublicPage(bookVersionId: string, key: string | undefined) {
    // «Версия открыта» — то же условие, что у карты и кластера (`openVersionWhere`); редакторский
    // `noindex` страницу не закрывает — её просмотры считаются.
    const found = await this.prisma.bookVersion.count({
      where: {
        AND: [
          { id: bookVersionId },
          openVersionWhere([]),
          {
            worldEntities: {
              some: key ? { key, ...WORLD_ENTITY_PUBLIC_WHERE } : WORLD_ENTITY_PUBLIC_WHERE,
            },
          },
        ],
      },
    });
    if (found === 0) throw new NotFoundException('World page not found');
  }

  /** Отчёт администратору: суммы за последние `days` суток по UTC, по версии, ключу и событию. */
  async report(
    bookVersionId: string | undefined,
    days = WORLD_STATS_DEFAULT_DAYS,
  ): Promise<WorldStatsResponseDto> {
    const to = utcDay(new Date());
    const from = new Date(
      Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - (days - 1)),
    );
    const rows = await this.prisma.worldDailyStat.groupBy({
      by: ['bookVersionId', 'key', 'event'],
      where: { day: { gte: from, lte: to }, ...(bookVersionId ? { bookVersionId } : {}) },
      _sum: { count: true },
      orderBy: [{ bookVersionId: 'asc' }, { key: 'asc' }, { event: 'asc' }],
      take: WORLD_STATS_ROW_LIMIT + 1,
    });
    const kept = rows.slice(0, WORLD_STATS_ROW_LIMIT);
    // Язык и слаг версии — «просмотры по языкам» (`product.md` §14 п.1) без сверки uuid руками.
    const ids = [...new Set(kept.map((r) => r.bookVersionId))];
    const versions =
      ids.length === 0
        ? []
        : await this.prisma.bookVersion.findMany({
            where: { id: { in: ids } },
            select: { id: true, language: true, slug: true },
            take: ids.length,
          });
    const byId = new Map(versions.map((v) => [v.id, v]));
    return {
      from: isoDay(from),
      to: isoDay(to),
      isTruncated: rows.length > WORLD_STATS_ROW_LIMIT,
      items: kept.map((r) => ({
        bookVersionId: r.bookVersionId,
        language: byId.get(r.bookVersionId)?.language ?? null,
        slug: byId.get(r.bookVersionId)?.slug ?? null,
        // Общая страница хранится пустой строкой (уникальный ключ), наружу — `null` (решение Q5a).
        key: r.key === '' ? null : r.key,
        event: r.event,
        count: r._sum.count ?? 0,
      })),
    };
  }
}
