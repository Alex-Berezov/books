import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ViewStatsService } from './view-stats.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../shared/cache/cache.interface';
import { PublicationStatus, ViewSource } from '@prisma/client';

interface PrismaStub {
  bookVersion: { findFirst: jest.Mock };
  viewStat: { create: jest.Mock };
  $queryRaw: jest.Mock;
}

interface CacheStub {
  get: jest.Mock;
  set: jest.Mock;
}

describe('ViewStatsService (unit)', () => {
  let service: ViewStatsService;
  let prisma: PrismaStub;
  let cache: CacheStub;

  const versionId = 'v-1111-2222';

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00Z'));
    prisma = {
      bookVersion: { findFirst: jest.fn() },
      viewStat: { create: jest.fn() },
      $queryRaw: jest.fn(),
    };
    cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    service = new ViewStatsService(
      prisma as unknown as PrismaService,
      cache as unknown as CacheService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('create: validates version existence', async () => {
    prisma.bookVersion.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.create('u1', { bookVersionId: versionId, source: ViewSource.text }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create: looks up only a published version (LEGACY-462)', async () => {
    prisma.bookVersion.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.create(null, { bookVersionId: versionId, source: ViewSource.text }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.bookVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.bookVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: versionId, status: PublicationStatus.published },
      }),
    );
    expect(prisma.viewStat.create).not.toHaveBeenCalled();
  });

  it('create: stores server time, not a client date (LEGACY-462)', async () => {
    prisma.bookVersion.findFirst.mockResolvedValueOnce({ id: versionId });
    prisma.viewStat.create.mockResolvedValueOnce({ id: 'vs1' });
    await service.create(null, {
      bookVersionId: versionId,
      source: ViewSource.text,
      // Поле снято из DTO; клиент мимо валидации всё равно не задаёт дату.
      ...({ timestamp: '2020-01-01T00:00:00Z' } as object),
    });
    const [{ data }] = prisma.viewStat.create.mock.calls[0] as [{ data: { timestamp: Date } }];
    expect(data.timestamp.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('create: ok stores view', async () => {
    prisma.bookVersion.findFirst.mockResolvedValueOnce({ id: versionId });
    prisma.viewStat.create.mockResolvedValueOnce({ id: 'vs1' });
    const res = await service.create('u1', { bookVersionId: versionId, source: ViewSource.text });
    expect(res).toEqual({ success: true });
    expect(prisma.viewStat.create).toHaveBeenCalled();
  });

  it('aggregate: returns cached when present and computes when not', async () => {
    // cached path
    cache.get.mockResolvedValueOnce({ total: 1, series: [{ date: '2025-01-01', count: 1 }] });
    const cached = await service.aggregate({ versionId, period: 'day' });
    expect(cached.total).toBe(1);

    // compute path
    cache.get.mockResolvedValueOnce(undefined);
    prisma.$queryRaw.mockResolvedValueOnce([
      { date: '2025-01-01', count: 2 },
      { date: '2025-01-02', count: 3 },
    ]);
    const agg = await service.aggregate({ versionId, period: 'week', source: ViewSource.text });
    expect(agg.total).toBe(5);
    expect(cache.set).toHaveBeenCalled();
    // Только опубликованные версии (LEGACY-471): поведение — e2e `view-stats.e2e-spec.ts`, здесь — что условие в запросе.
    const [stmt] = prisma.$queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(stmt.sql).toContain(`bv.status = 'published'::"PublicationStatus"`);
  });

  it('top: validates range ordering and caches result', async () => {
    // compute path
    cache.get.mockResolvedValueOnce(undefined);
    prisma.$queryRaw.mockResolvedValueOnce([
      { bookVersionId: 'v1', count: 5 },
      { bookVersionId: 'v2', count: 3 },
    ]);
    const res = await service.top({ period: 'month', limit: 10 });
    expect(res.items[0].bookVersionId).toBe('v1');
    // Только опубликованные версии (LEGACY-462): поведение проверяет e2e, здесь — что условие в запросе.
    const [stmt] = prisma.$queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(stmt.sql).toContain(`bv.status = 'published'::"PublicationStatus"`);
    expect(res.totalVersions).toBe(2);
    expect(cache.set).toHaveBeenCalled();
  });

  it('aggregate: supports source filter and throws when from>to', async () => {
    cache.get.mockResolvedValueOnce(undefined);
    prisma.$queryRaw.mockResolvedValueOnce([{ date: '2025-01-01', count: 1 }]);
    const ok = await service.aggregate({ versionId, period: 'day', source: ViewSource.audio });
    expect(ok.total).toBe(1);

    await expect(
      service.aggregate({ versionId, period: 'week', from: '2025-02-01', to: '2025-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('top: applies source and limit, caches with TTL', async () => {
    cache.get.mockResolvedValueOnce(undefined);
    prisma.$queryRaw.mockResolvedValueOnce([
      { bookVersionId: 'v1', count: 2 },
      { bookVersionId: 'v2', count: 1 },
    ]);
    const res = await service.top({ period: 'week', limit: 2, source: ViewSource.referral });
    expect(res.items.length).toBe(2);
    expect(cache.set).toHaveBeenCalled();
  });
});
