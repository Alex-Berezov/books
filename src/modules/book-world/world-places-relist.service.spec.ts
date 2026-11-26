import { Logger, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { WORLD_PLACES } from './world-public';
import { WORLD_PLACES_RELIST_PAGE, WorldPlacesRelistService } from './world-places-relist.service';

/**
 * Разовый пересчёт мест при старте (`F08-12c`, решение `F08 | F08-12a` R4). Транзакция мира —
 * подставка: замок, строка версии и сама версия; `relistWorldPlaces` пишет только изменённое.
 */
describe('WorldPlacesRelistService (F08-12c)', () => {
  const place = (
    key: string,
    isListed: boolean,
    firstPublishedAt: Date | null = isListed ? new Date(1) : null,
  ) => ({
    key,
    type: 'place',
    role: null,
    hasCore: true,
    isVisible: true,
    readAt: null,
    autoTextAt: null,
    mentions: null,
    isListed,
    // По умолчанию: на сайте уже была — отметка первой публикации стоит.
    firstPublishedAt,
    updatedAt: new Date(1),
  });
  const make = (
    versions: string[][],
    places: ReturnType<typeof place>[] = [],
    status: 'published' | 'draft' = 'published',
  ) => {
    const pages = [...versions];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bookVersion: { findUnique: jest.fn().mockResolvedValue({ status }) },
      bookWorldEntity: {
        findMany: jest.fn().mockResolvedValue(places),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      bookVersion: {
        findMany: jest
          .fn()
          .mockImplementation(() => Promise.resolve((pages.shift() ?? []).map((id) => ({ id })))),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    return {
      prisma,
      tx,
      service: new WorldPlacesRelistService(prisma as unknown as PrismaService),
    };
  };
  afterEach(() => {
    WORLD_PLACES.public = true;
    jest.restoreAllMocks();
  });

  it('рубильник выключен — ни одного запроса ни при старте, ни прямым вызовом', async () => {
    WORLD_PLACES.public = false;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { prisma, service } = make([['v-1']]);
    service.onApplicationBootstrap();
    await service.onModuleDestroy();
    // Старт не заводит пересчёт вовсе: ни запроса, ни строки журнала «0 written».
    expect(log).not.toHaveBeenCalled();
    await expect(service.relistAll()).resolves.toEqual({ written: 0, failed: 0 });
    expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(0);
  });

  it('пишет только изменившиеся места с прежним updatedAt, каждой версии — своя транзакция', async () => {
    const { prisma, tx, service } = make([['v-1', 'v-2']], [place('a', false), place('b', true)]);
    await expect(service.relistAll()).resolves.toEqual({ written: 2, failed: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // Выборка мест версии — только места этой версии, с потолком.
    expect(tx.bookWorldEntity.findMany).toHaveBeenCalledTimes(2);
    expect(tx.bookWorldEntity.findMany.mock.calls[0][0]).toMatchObject({
      where: { bookVersionId: 'v-1', type: 'place' },
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(2);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
      where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'a' } },
      data: { isListed: true, firstPublishedAt: expect.any(Date), updatedAt: new Date(1) },
    });
  });

  it('черновик: isListed ставится, отметки первой публикации нет', async () => {
    const { tx, service } = make([['v-1']], [place('a', false)], 'draft');
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 0 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
      where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'a' } },
      data: { isListed: true, updatedAt: new Date(1) },
    });
  });

  it('версии порциями по версиям, а не по строкам мест: полная порция — следующий запрос после последней', async () => {
    const full = Array.from(
      { length: WORLD_PLACES_RELIST_PAGE },
      (_, i) => `v-${String(i).padStart(4, '0')}`,
    );
    const { prisma, service } = make([full, ['v-9999']]);
    await service.relistAll();
    expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.bookVersion.findMany.mock.calls[0][0]).toEqual({
      where: { worldEntities: { some: { type: 'place' } } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: WORLD_PLACES_RELIST_PAGE,
    });
    expect(prisma.bookVersion.findMany.mock.calls[1][0]).toEqual({
      where: { worldEntities: { some: { type: 'place' } }, id: { gt: full[full.length - 1] } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: WORLD_PLACES_RELIST_PAGE,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(WORLD_PLACES_RELIST_PAGE + 1);
  });

  it('отказ одной версии пишется в журнал и не обрывает остальные', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, tx, service } = make([['v-1', 'v-2']], [place('a', false)]);
    prisma.$transaction.mockImplementationOnce(() =>
      Promise.reject(new NotFoundException('BookVersion not found')),
    );
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 1 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookVersionId_key: { bookVersionId: 'v-2', key: 'a' } },
      }),
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'World places relist failed for version v-1',
      expect.stringContaining('BookVersion not found'),
    );
    // Отказавшую версию дочитает очередь пересчёта присутствия: строка ставится ровно ей.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual(['v-1', 'v-1']);
  });

  it('отказ постановки в очередь - строка журнала, проход идёт дальше', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, service } = make([['v-1', 'v-2']], [place('a', false)]);
    prisma.$transaction.mockImplementationOnce(() => Promise.reject(new Error('P2028')));
    prisma.$executeRaw.mockRejectedValueOnce(new Error('queue down'));
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 1 });
    expect(error).toHaveBeenCalledWith(
      'World places relist could not queue version v-1 for recount',
      expect.stringContaining('queue down'),
    );
    // Отказ версии и отказ её постановки - ровно две строки; в очередь ставится только v-1.
    expect(error).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('место на сайте без отметки первой публикации получает её, isListed не меняется', async () => {
    const { tx, service } = make([['v-1']], [place('a', true, null)]);
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 0 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
      where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'a' } },
      data: { isListed: true, firstPublishedAt: expect.any(Date), updatedAt: new Date(1) },
    });
  });

  it('старт с включённым рубильником: пересчёт идёт в фоне, остановка его дожидается, итог в журнале', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { tx, service } = make([['v-1']], [place('a', false)]);
    service.onApplicationBootstrap();
    await service.onModuleDestroy();
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'World places relisted at startup: 1 written, 0 versions failed',
    );
  });

  it('отказ выборки версий при старте пишется в журнал и не роняет процесс', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, service } = make([]);
    prisma.bookVersion.findMany.mockRejectedValue(new Error('db down'));
    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'World places relist did not run at startup',
      expect.stringContaining('db down'),
    );
  });
});
