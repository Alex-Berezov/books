import { Logger, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { BOOK_WORLD_LIMITS, WORLD_OBJECT_TYPES } from './dto/book-world-blocks.dto';
import { WORLD_OBJECTS } from './world-public';
import {
  WORLD_OBJECTS_RELIST_PAGE,
  WorldObjectsRelistService,
} from './world-objects-relist.service';

/**
 * Разовый пересчёт предметов, понятий и событий при старте (`F08-13c`, решение `F08 | F08-13` Q6).
 * Транзакция мира — подставка: замок, строка версии и сама версия; `relistWorldObjects` пишет только
 * изменённое.
 */
describe('WorldObjectsRelistService (F08-13c)', () => {
  const row = (
    key: string,
    isListed: boolean,
    firstPublishedAt: Date | null = isListed ? new Date(1) : null,
    type: string = 'object',
  ) => ({
    key,
    type,
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
    rows: ReturnType<typeof row>[] = [],
    status: 'published' | 'draft' = 'published',
  ) => {
    const pages = [...versions];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bookVersion: { findUnique: jest.fn().mockResolvedValue({ status }) },
      bookWorldEntity: {
        findMany: jest.fn().mockResolvedValue(rows),
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
      service: new WorldObjectsRelistService(prisma as unknown as PrismaService),
    };
  };
  afterEach(() => {
    WORLD_OBJECTS.public = true;
    jest.restoreAllMocks();
  });

  it('рубильник выключен — ни одного запроса ни при старте, ни прямым вызовом', async () => {
    WORLD_OBJECTS.public = false;
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

  it('пишет только изменившиеся строки трёх типов с прежним updatedAt, каждой версии — своя транзакция', async () => {
    const { prisma, tx, service } = make(
      [['v-1', 'v-2']],
      [row('a', false), row('b', true, new Date(1), 'term'), row('c', true, new Date(1), 'event')],
    );
    await expect(service.relistAll()).resolves.toEqual({ written: 2, failed: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // Выборка версии — предметы, понятия и события этой версии, с потолком.
    expect(tx.bookWorldEntity.findMany).toHaveBeenCalledTimes(2);
    expect(tx.bookWorldEntity.findMany.mock.calls[0][0]).toMatchObject({
      where: { bookVersionId: 'v-1', type: { in: [...WORLD_OBJECT_TYPES] } },
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(2);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
      where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'a' } },
      data: { isListed: true, firstPublishedAt: expect.any(Date), updatedAt: new Date(1) },
    });
  });

  it('понятие и событие, записанные при выключенном рубильнике, выходят на сайт; у строки на сайте лишнего не пишется', async () => {
    const { tx, service } = make(
      [['v-1']],
      [
        row('t', false, null, 'term'),
        row('e', false, null, 'event'),
        row('o', true, new Date(1), 'object'),
      ],
    );
    await expect(service.relistAll()).resolves.toEqual({ written: 2, failed: 0 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(2);
    for (const key of ['t', 'e']) {
      expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
        where: { bookVersionId_key: { bookVersionId: 'v-1', key } },
        data: { isListed: true, firstPublishedAt: expect.any(Date), updatedAt: new Date(1) },
      });
    }
  });

  it('обратная сторона: строка на сайте без ядра, скрытая или непрочитанная после текста модели снимается; без ядра и вне сайта - не трогается', async () => {
    const off = (key: string, over: Record<string, unknown>) => ({ ...row(key, true), ...over });
    const { tx, service } = make(
      [['v-1']],
      [
        off('nocore', { hasCore: false }),
        off('hidden', { isVisible: false }),
        off('unread', { autoTextAt: new Date(2), readAt: new Date(1) }),
        { ...row('idle', false), hasCore: false },
      ],
    );
    await expect(service.relistAll()).resolves.toEqual({ written: 3, failed: 0 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(3);
    for (const key of ['nocore', 'hidden', 'unread']) {
      expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
        where: { bookVersionId_key: { bookVersionId: 'v-1', key } },
        data: { isListed: false, updatedAt: new Date(1) },
      });
    }
  });

  it('черновик: isListed ставится, отметки первой публикации нет', async () => {
    const { tx, service } = make([['v-1']], [row('a', false)], 'draft');
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 0 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
      where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'a' } },
      data: { isListed: true, updatedAt: new Date(1) },
    });
  });

  it('версии порциями по версиям, а не по строкам: полная порция — следующий запрос после последней', async () => {
    const full = Array.from(
      { length: WORLD_OBJECTS_RELIST_PAGE },
      (_, i) => `v-${String(i).padStart(4, '0')}`,
    );
    const { prisma, service } = make([full, ['v-9999']]);
    await service.relistAll();
    expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.bookVersion.findMany.mock.calls[0][0]).toEqual({
      where: { worldEntities: { some: { type: { in: [...WORLD_OBJECT_TYPES] } } } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: WORLD_OBJECTS_RELIST_PAGE,
    });
    expect(prisma.bookVersion.findMany.mock.calls[1][0]).toEqual({
      where: {
        worldEntities: { some: { type: { in: [...WORLD_OBJECT_TYPES] } } },
        id: { gt: full[full.length - 1] },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: WORLD_OBJECTS_RELIST_PAGE,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(WORLD_OBJECTS_RELIST_PAGE + 1);
  });

  it('отказ одной версии пишется в журнал и не обрывает остальные', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, tx, service } = make([['v-1', 'v-2']], [row('a', false)]);
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
      'World objects relist failed for version v-1',
      expect.stringContaining('BookVersion not found'),
    );
    // Отказавшую версию дочитает очередь пересчёта присутствия: строка ставится ровно ей.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual(['v-1', 'v-1']);
  });

  it('отказ постановки в очередь - строка журнала, проход идёт дальше', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, service } = make([['v-1', 'v-2']], [row('a', false)]);
    prisma.$transaction.mockImplementationOnce(() => Promise.reject(new Error('P2028')));
    prisma.$executeRaw.mockRejectedValueOnce(new Error('queue down'));
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 1 });
    expect(error).toHaveBeenCalledWith(
      'World objects relist could not queue version v-1 for recount',
      expect.stringContaining('queue down'),
    );
    // Отказ версии и отказ её постановки - ровно две строки; в очередь ставится только v-1.
    expect(error).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('строка на сайте без отметки первой публикации получает её, isListed не меняется', async () => {
    const { tx, service } = make([['v-1']], [row('a', true, null)]);
    await expect(service.relistAll()).resolves.toEqual({ written: 1, failed: 0 });
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(tx.bookWorldEntity.update).toHaveBeenCalledWith({
      where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'a' } },
      data: { isListed: true, firstPublishedAt: expect.any(Date), updatedAt: new Date(1) },
    });
  });

  it('старт с включённым рубильником: пересчёт идёт в фоне, остановка его дожидается, итог в журнале', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { tx, service } = make([['v-1']], [row('a', false)]);
    service.onApplicationBootstrap();
    await service.onModuleDestroy();
    expect(tx.bookWorldEntity.update).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'World objects relisted at startup: 1 written, 0 versions failed',
    );
  });

  it('отказ выборки версий при старте пишется в журнал и не роняет процесс', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, service } = make([]);
    prisma.bookVersion.findMany.mockRejectedValue(new Error('db down'));
    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'World objects relist did not run at startup',
      expect.stringContaining('db down'),
    );
  });
});
