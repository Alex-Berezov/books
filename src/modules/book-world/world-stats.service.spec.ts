import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  WORLD_STATS_ROW_LIMIT,
  WorldStatsService,
  worldStatIncrementSql,
} from './world-stats.service';

const VERSION = '0b0b0b0b-0000-4000-8000-000000000001';

type GroupRow = {
  bookVersionId: string;
  key: string;
  event: string;
  _sum: { count: number | null };
};

function setup(opts: { found?: number; groups?: GroupRow[] } = {}) {
  const executeRaw = jest.fn().mockResolvedValue(1);
  const count = jest.fn().mockResolvedValue(opts.found ?? 1);
  const groupBy = jest.fn().mockResolvedValue(opts.groups ?? []);
  const findMany = jest.fn().mockResolvedValue([{ id: VERSION, language: 'en', slug: 'book-en' }]);
  const db = {
    $executeRaw: executeRaw,
    worldDailyStat: { groupBy },
    bookVersion: { count, findMany },
  };
  const service = new WorldStatsService(db as unknown as PrismaService);
  return { service, executeRaw, count, groupBy, findMany };
}

describe('WorldStatsService (F08-3, решение арбитра Q5)', () => {
  it('+1 одним оператором ON CONFLICT по уникальному ключу дня; день — сутки UTC строкой', () => {
    const sql = worldStatIncrementSql(
      VERSION,
      'olga',
      'view',
      new Date('2026-11-16T23:59:59.999Z'),
    );
    expect(sql.sql).toMatch(/INSERT INTO "WorldDailyStat"/);
    expect(sql.sql).toMatch(
      /ON CONFLICT \("day", "bookVersionId", "key", "event"\)\s+DO UPDATE SET "count" = "WorldDailyStat"\."count" \+ 1/,
    );
    expect(sql.values.slice(1)).toEqual(['2026-11-16', VERSION, 'olga', 'view']);
  });

  it('событие общей страницы: пустой ключ, любая публичная сущность; одна запись', async () => {
    const { service, executeRaw, count } = setup();
    await service.record({ bookVersionId: VERSION, event: 'view' }, 'Mozilla/5.0');
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0][0].where).toEqual({
      AND: [
        { id: VERSION },
        { AND: [{ status: 'published', slug: { not: null } }, {}] },
        { worldEntities: { some: { isListed: true } } },
      ],
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values.slice(2)).toEqual([VERSION, '', 'view']);
  });

  it('бот — без записи и без чтения базы', async () => {
    const { service, executeRaw, count } = setup();
    await service.record(
      { bookVersionId: VERSION, event: 'view' },
      'Mozilla/5.0 (compatible; bingbot/2.0)',
    );
    expect(count).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('страницы нет — 404, запись не идёт; сущность ищется по ключу и isListed', async () => {
    const { service, executeRaw, count } = setup({ found: 0 });
    const err = await service
      .record({ bookVersionId: VERSION, key: 'olga', event: 'view' }, undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
    expect(count.mock.calls[0][0].where.AND).toEqual([
      { id: VERSION },
      { AND: [{ status: 'published', slug: { not: null } }, {}] },
      { worldEntities: { some: { key: 'olga', isListed: true } } },
    ]);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  describe('отчёт', () => {
    const group = (key: string, count: number | null): GroupRow => ({
      bookVersionId: VERSION,
      key,
      event: 'view',
      _sum: { count },
    });

    it('окно — последние days суток UTC; фильтр версии; язык и слаг; общая страница — key null (Q5a)', async () => {
      const { service, groupBy } = setup({ groups: [group('', null), group('olga', 5)] });
      const res = await service.report(VERSION, 7);
      const arg = groupBy.mock.calls[0][0];
      const from: Date = arg.where.day.gte;
      const to: Date = arg.where.day.lte;
      expect(to.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect((to.getTime() - from.getTime()) / 86_400_000).toBe(6);
      expect(arg.where.bookVersionId).toBe(VERSION);
      expect(arg.take).toBe(WORLD_STATS_ROW_LIMIT + 1);
      expect(res).toEqual({
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        isTruncated: false,
        items: [
          {
            bookVersionId: VERSION,
            language: 'en',
            slug: 'book-en',
            key: null,
            event: 'view',
            count: 0,
          },
          {
            bookVersionId: VERSION,
            language: 'en',
            slug: 'book-en',
            key: 'olga',
            event: 'view',
            count: 5,
          },
        ],
      });
    });

    it('строк больше потолка — truncated и ровно потолок строк', async () => {
      const groups = Array.from({ length: WORLD_STATS_ROW_LIMIT + 1 }, (_, i) => group(`k${i}`, 1));
      const { service, groupBy } = setup({ groups });
      const res = await service.report(undefined, 1);
      expect(groupBy.mock.calls[0][0].where).not.toHaveProperty('bookVersionId');
      expect(res.isTruncated).toBe(true);
      expect(res.items).toHaveLength(WORLD_STATS_ROW_LIMIT);
    });
  });
});
