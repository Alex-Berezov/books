/* eslint-disable */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ViewStatsService } from './view-stats.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_SERVICE } from '../../shared/cache/cache.interface';
import { ViewSource } from '@prisma/client';

describe('ViewStatsService (unit)', () => {
  let service: ViewStatsService;
  let prisma: any;
  let cache: any;

  const versionId = 'v-1111-2222';

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00Z'));
    prisma = {
      bookVersion: { findUnique: jest.fn() },
      viewStat: { create: jest.fn() },
      $queryRaw: jest.fn(),
    } as any;
    cache = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
    };
    service = new ViewStatsService(prisma as PrismaService, cache);
  });

  afterEach(() => jest.useRealTimers());

  it('create: validates version existence', async () => {
    prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.create('u1', { bookVersionId: versionId, source: ViewSource.text }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create: rejects future timestamp and invalid date', async () => {
    prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: versionId });
    await expect(
      service.create(null, {
        bookVersionId: versionId,
        source: ViewSource.text,
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: versionId });
    await expect(
      service.create(null, { bookVersionId: versionId, source: ViewSource.text, timestamp: 'bad' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: ok stores view', async () => {
    prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: versionId });
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
    expect(res.totalVersions).toBe(2);
    expect(cache.set).toHaveBeenCalled();
  });
});
