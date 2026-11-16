import { ChapterService } from './chapter.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import {
  ClearanceLockFake,
  createClearanceLockFake,
} from '../../common/testing/clearance-lock-fake';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Chapter, Prisma } from '@prisma/client';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';

interface PrismaStub {
  bookVersion: {
    findUnique: jest.Mock;
  };
  chapter: {
    findMany: (args: Prisma.ChapterFindManyArgs) => Promise<Chapter[]>;
    count: jest.Mock;
    findFirst: (args: Prisma.ChapterFindFirstArgs) => Promise<{ id: string } | null>;
    create: (args: Prisma.ChapterCreateArgs) => Promise<Chapter>;
    findUnique: (args: Prisma.ChapterFindUniqueArgs) => Promise<{ id: string } | null>;
    update: (args: Prisma.ChapterUpdateArgs) => Promise<Chapter>;
    delete: (args: Prisma.ChapterDeleteArgs) => Promise<Chapter>;
  };
  $transaction: (arg: unknown) => Promise<unknown>;
  /** Очередь пересчёта мира книги (F08-2, `markWorldMentionsDirty`). */
  $executeRaw: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    bookVersion: {
      findUnique: jest.fn().mockResolvedValue({ status: 'published' }),
    },
    chapter: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    // Массив — пакетная форма (`$transaction([...])`), функция — интерактивная.
    $transaction: (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : Promise.resolve((arg as (tx: PrismaStub) => unknown)(stub)),
  };
  return stub;
};

/** Версии, поставленные в очередь пересчёта мира книги (`markWorldMentionsDirty`) этим клиентом. */
const worldQueueVersions = (executeRaw: jest.Mock): unknown[] =>
  executeRaw.mock.calls
    .filter(([strings]) => (strings as string[]).join('?').includes('"WorldMentionsPending"'))
    .map(([, versionId]) => versionId as unknown);

describe('ChapterService', () => {
  let service: ChapterService;
  let prisma: PrismaStub;
  let mockRightsContentHashService: jest.Mocked<RightsContentHashService>;
  let clearanceLock: ClearanceLockFake;
  let adminAudit: { record: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    mockRightsContentHashService = {
      computeVersionHash: jest.fn(),
      initializeVersionBaseline: jest.fn(),
      checkVersionStaleness: jest.fn(),
      markVersionAndClearanceStale: jest.fn(),
    } as unknown as jest.Mocked<RightsContentHashService>;
    clearanceLock = createClearanceLockFake(prisma);
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ChapterService(
      prisma as unknown as PrismaService,
      mockRightsContentHashService,
      { assertAccess: jest.fn() } as unknown as GeoBlockRuleService,
      clearanceLock.service,
      adminAudit as unknown as AdminAuditService,
    );
  });

  /**
   * `LEGACY-368`: запись главы идёт внутри транзакции под замком группы клиренса. Запись
   * мимо обёртки снова даёт 40P01 со встречной правкой главы соседней версии.
   */
  describe('writes run under the clearance lock', () => {
    const underLock = (write: jest.Mock, result: unknown): boolean[] => {
      const seen: boolean[] = [];
      write.mockImplementation(() => {
        seen.push(clearanceLock.isLocked());
        return Promise.resolve(result);
      });
      return seen;
    };

    it('create', async () => {
      (prisma.chapter.findFirst as jest.Mock).mockResolvedValue(null);
      const seen = underLock(prisma.chapter.create as jest.Mock, { id: 'c1' });

      await service.create('v1', { number: 1, title: 'T', content: 'C' });

      expect(seen).toEqual([true]);
      expect(clearanceLock.lockedVersions).toEqual(['v1']);
    });

    /**
     * F08-2: каждый путь записи главы ставит версию в очередь пересчёта мира книги **клиентом
     * транзакции под замком**, а не корневым: запись мимо `tx` закоммитилась бы до главы и пережила
     * бы её откат. Клиент транзакции — свой объект, корневой `$executeRaw` не должен звучать.
     */
    describe('очередь мира книги (F08-2) — через клиент транзакции', () => {
      const lockedService = () => {
        const tx = {
          chapter: {
            // Глава, перечитанная под замком: с ней сравнивается правка (очередь мира, R4).
            findUnique: jest.fn().mockResolvedValue({ content: '<p>old</p>', number: 1 }),
            update: jest.fn().mockResolvedValue({ id: 'c1' }),
            delete: jest.fn().mockResolvedValue({ id: 'c1' }),
            create: jest.fn().mockResolvedValue({ id: 'c2' }),
          },
          bookVersion: { findUnique: jest.fn().mockResolvedValue({ status: 'draft' }) },
          $executeRaw: jest.fn().mockResolvedValue(1),
          // Глава под замком (`lockChapter`): с её текстом сравнивается перезапись.
          $queryRaw: jest.fn().mockResolvedValue([{ id: 'c1', content: '<p>old</p>', title: 'T' }]),
        };
        (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({
          id: 'c1',
          bookVersionId: 'v1',
          number: 1,
        });
        const locked = new ChapterService(
          prisma as unknown as PrismaService,
          mockRightsContentHashService,
          { assertAccess: jest.fn() } as unknown as GeoBlockRuleService,
          createClearanceLockFake(tx).service,
          adminAudit as unknown as AdminAuditService,
        );
        return { tx, locked };
      };

      it('update', async () => {
        const { tx, locked } = lockedService();
        await locked.update('c1', { content: '<p>new</p>' });
        expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1']);
        expect(worldQueueVersions(prisma.$executeRaw)).toEqual([]);
      });

      it('update: только название или тот же текст — очереди нет; номер — есть (R4)', async () => {
        const { tx, locked } = lockedService();
        tx.chapter.findUnique.mockResolvedValue({ content: '<p>same</p>', number: 1 });
        await locked.update('c1', { title: 'New title' });
        await locked.update('c1', { content: '<p>same</p>' });
        expect(worldQueueVersions(tx.$executeRaw)).toEqual([]);
        await locked.update('c1', { number: 2 });
        expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1']);
      });

      it('update: сравнение — с главой под замком, а не с чтением до него', async () => {
        const { tx, locked } = lockedService();
        // До замка прочитано «X» (как в dto), под замком — уже «Y» от соседа: текст меняется.
        (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({
          id: 'c1',
          bookVersionId: 'v1',
          number: 1,
          content: '<p>X</p>',
        });
        tx.chapter.findUnique.mockResolvedValue({ content: '<p>Y</p>', number: 1 });
        await locked.update('c1', { content: '<p>X</p>' });
        expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1']);
      });

      it('remove', async () => {
        const { tx, locked } = lockedService();
        await locked.remove('c1', null);
        expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1']);
        expect(worldQueueVersions(prisma.$executeRaw)).toEqual([]);
      });

      it('rewriteLocked: замена текста и новая глава перевода', async () => {
        const { tx, locked } = lockedService();
        await locked.rewriteLocked('v1', async (_tx, writer) => {
          await writer.write({ id: 'c1', number: 1, title: 'T', content: '<p>x</p>' });
          await writer.write({ number: 2, title: 'T2', content: '<p>y</p>' });
        });
        expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1', 'v1']);
        expect(worldQueueVersions(prisma.$executeRaw)).toEqual([]);
      });

      it('rewriteLocked: перезапись тем же текстом очередь не ставит (R4, R3)', async () => {
        const { tx, locked } = lockedService();
        await locked.rewriteLocked('v1', async (_tx, writer) => {
          await writer.lockChapter('c1');
          await writer.write({ id: 'c1', number: 1, title: 'T', content: '<p>old</p>' });
          await writer.write({ id: 'c1', number: 1, title: 'T', content: '<p>new</p>' });
        });
        expect(tx.chapter.update).toHaveBeenCalledTimes(2);
        // Только вторая запись (другой текст) ставит очередь.
        expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1']);
      });

      it('update: правка одного названия главу под замком не перечитывает', async () => {
        const { tx, locked } = lockedService();
        await locked.update('c1', { title: 'New title' });
        expect(tx.chapter.findUnique).not.toHaveBeenCalled();
        expect(worldQueueVersions(tx.$executeRaw)).toEqual([]);
      });
    });

    /**
     * `F05-6`, 6b: общий путь ручной главы и главы запуска перевода - запись, пометка свежести
     * прав и колбэк вызывающего одной транзакцией под замком.
     */
    it('createLocked: staleness and the caller callback in the same locked transaction', async () => {
      // Клиент транзакции - свой объект, а не корневой клиент сервиса: запись мимо `tx`
      // (через `this.prisma`) спека отличает.
      const tx = { chapter: { create: jest.fn() }, $executeRaw: jest.fn().mockResolvedValue(1) };
      const lock = createClearanceLockFake(tx);
      const staleness = jest.fn();
      const locked = new ChapterService(
        prisma as unknown as PrismaService,
        { checkVersionStaleness: staleness } as unknown as RightsContentHashService,
        { assertAccess: jest.fn() } as unknown as GeoBlockRuleService,
        lock.service,
        adminAudit as unknown as AdminAuditService,
      );
      const seen: boolean[] = [];
      tx.chapter.create.mockImplementation(() => {
        seen.push(lock.isLocked());
        return Promise.resolve({ id: 'c1' });
      });
      const afterCreate = jest.fn().mockImplementation(() => {
        seen.push(lock.isLocked());
        return Promise.resolve();
      });

      await locked.createLocked('v1', { number: 2, title: 'T', content: 'C' }, afterCreate);

      expect(seen).toEqual([true, true]);
      expect(prisma.chapter.create).not.toHaveBeenCalled();
      expect(staleness).toHaveBeenCalledTimes(1);
      expect(staleness).toHaveBeenCalledWith('v1', 'CHAPTER_CREATED', null, true, tx);
      expect(afterCreate).toHaveBeenCalledTimes(1);
      expect(afterCreate).toHaveBeenCalledWith(tx, { id: 'c1' });
      // Мир книги (F08-2): версия встаёт в очередь пересчёта в той же транзакции.
      expect(worldQueueVersions(tx.$executeRaw)).toEqual(['v1']);
    });

    it('update', async () => {
      (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({
        id: 'c1',
        bookVersionId: 'v1',
        number: 1,
      });
      const seen = underLock(prisma.chapter.update as jest.Mock, { id: 'c1' });

      await service.update('c1', { title: 'T2' });

      expect(seen).toEqual([true]);
      expect(clearanceLock.lockedVersions).toEqual(['v1']);
    });

    it('remove', async () => {
      (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({ id: 'c1', bookVersionId: 'v1' });
      const seen = underLock(prisma.chapter.delete as jest.Mock, { id: 'c1' });

      await service.remove('c1', 'admin-1');

      expect(seen).toEqual([true]);
      expect(clearanceLock.lockedVersions).toEqual(['v1']);
    });

    /**
     * `LEGACY-015`, пачка `T19`. Событие пишется тем же клиентом транзакции,
     * что и само удаление: иначе оно переживёт откат (`LEGACY-036`). Что запись
     * идёт именно через `tx`, а не через корневой клиент, статически сторожит
     * `src/common/testing/admin-audit-writers.spec.ts`; здесь проверяется состав.
     */
    it('remove пишет CHAPTER_DELETED под тем же замком', async () => {
      (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({ id: 'c1', bookVersionId: 'v1' });
      (prisma.chapter.delete as jest.Mock).mockResolvedValue({ id: 'c1' });

      await service.remove('c1', 'admin-1');

      expect(adminAudit.record).toHaveBeenCalledTimes(1);
      expect(adminAudit.record.mock.calls[0][1]).toEqual({
        action: 'CHAPTER_DELETED',
        targetType: 'CHAPTER',
        targetId: 'c1',
        actorUserId: 'admin-1',
        payload: { bookVersionId: 'v1' },
      });
      expect(clearanceLock.lockedVersions).toEqual(['v1']);
    });

    it('remove несуществующей главы журнала не касается', async () => {
      (prisma.chapter.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.remove('missing', 'admin-1')).rejects.toThrow(NotFoundException);
      expect(adminAudit.record).not.toHaveBeenCalled();
    });
  });

  it('lists all chapters by version when no pagination', async () => {
    (prisma.chapter.findMany as jest.Mock).mockResolvedValue([
      { id: 'c1', number: 1 },
      { id: 'c2', number: 2 },
    ]);
    const res = await service.listByVersion('v1');
    expect(res.items).toHaveLength(2);
    expect(res.pagination).toEqual({ page: 1, limit: 2, total: 2, totalPages: 1 });
    // Весь список одной страницей: `total` — длина выдачи, второй запрос не нужен.
    expect(prisma.chapter.count).not.toHaveBeenCalled();
    expect(prisma.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      orderBy: { number: 'asc' },
    });
  });

  it('lists chapters with pagination when page and limit provided', async () => {
    (prisma.chapter.findMany as jest.Mock).mockResolvedValue([{ id: 'c1', number: 1 }]);
    prisma.chapter.count.mockResolvedValue(11);
    const res = await service.listByVersion('v1', 1, 10);
    expect(res.items).toHaveLength(1);
    // Настоящий `total`, а не длина страницы: иначе потребитель не отличит недобор.
    expect(res.pagination).toEqual({ page: 1, limit: 10, total: 11, totalPages: 2 });
    expect(prisma.chapter.count).toHaveBeenCalledTimes(1);
    expect(prisma.chapter.count).toHaveBeenCalledWith({ where: { bookVersionId: 'v1' } });
    expect(prisma.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      orderBy: { number: 'asc' },
      skip: 0,
      take: 10,
    });
  });

  it('rejects public listing for a version that is not published', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ status: 'draft' });
    await expect(service.listByVersion('v1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists chapters of a draft version for admin', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });
    (prisma.chapter.findMany as jest.Mock).mockResolvedValue([{ id: 'c1', number: 1 }]);
    const res = await service.listAdminByVersion('v1');
    expect(res.items).toHaveLength(1);
    expect(prisma.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      orderBy: { number: 'asc' },
    });
  });

  // F03-1 (А5): «Вводные для промпта» — номера и названия без текста глав; `total` настоящий,
  // усечение пределом видно потребителю (`LEGACY-098`).
  it('lists chapter titles without content and with the real total', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });
    (prisma.chapter.findMany as jest.Mock).mockResolvedValue([{ number: 1, title: 'One' }]);
    prisma.chapter.count.mockResolvedValue(6000);
    const res = await service.listAdminTitles('v1');
    expect(prisma.chapter.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      orderBy: { number: 'asc' },
      select: { number: true, title: true },
      take: 5000,
    });
    expect(prisma.chapter.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.chapter.count).toHaveBeenCalledWith({ where: { bookVersionId: 'v1' } });
    expect(res.items).toEqual([{ number: 1, title: 'One' }]);
    expect(res.pagination.total).toBe(6000);
  });

  it('rejects chapter titles when the version does not exist', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.listAdminTitles('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects admin listing when the version does not exist', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.listAdminByVersion('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates unique chapter by number', async () => {
    (prisma.chapter.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.chapter.create as jest.Mock).mockResolvedValue({ id: 'c1' });
    const res = await service.create('v1', { number: 1, title: 'T', content: 'C' });
    expect(res.id).toBe('c1');
  });

  it('auto-assigns next chapter number when number is omitted', async () => {
    // First findFirst call (auto-assign): returns last chapter with number 5
    // Second findFirst call (uniqueness check): returns null (no conflict)
    (prisma.chapter.findFirst as jest.Mock)
      .mockResolvedValueOnce({ number: 5 }) // last chapter
      .mockResolvedValueOnce(null); // uniqueness check
    (prisma.chapter.create as jest.Mock).mockResolvedValue({ id: 'c2', number: 6 });
    const res = await service.create('v1', { title: 'T', content: 'C' });
    expect(res.number).toBe(6);
    expect(prisma.chapter.create).toHaveBeenCalledWith({
      data: { bookVersionId: 'v1', number: 6, title: 'T', content: 'C' },
    });
  });

  it('auto-assigns number 1 when no chapters exist and number is omitted', async () => {
    (prisma.chapter.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // no last chapter
      .mockResolvedValueOnce(null); // uniqueness check
    (prisma.chapter.create as jest.Mock).mockResolvedValue({ id: 'c1', number: 1 });
    const res = await service.create('v1', { title: 'T', content: 'C' });
    expect(res.number).toBe(1);
  });

  it('rejects duplicate number', async () => {
    (prisma.chapter.findFirst as jest.Mock).mockResolvedValue({ id: 'exists' });
    await expect(
      service.create('v1', { number: 1, title: 'T', content: 'C' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gets chapter', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({ id: 'c1' });
    const res = await service.get('c1');
    expect(res.id).toBe('c1');
  });

  it('throws not found for missing chapter', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates chapter with number uniqueness check', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({
      id: 'c1',
      bookVersionId: 'v1',
      number: 1,
    });
    (prisma.chapter.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.chapter.update as jest.Mock).mockResolvedValue({ id: 'c1', number: 2 });
    const res = await service.update('c1', { number: 2 });
    expect(res.number).toBe(2);
  });

  it('removes chapter', async () => {
    (prisma.chapter.findUnique as jest.Mock).mockResolvedValue({ id: 'c1' });
    (prisma.chapter.delete as jest.Mock).mockResolvedValue({ id: 'c1' });
    const res = await service.remove('c1', 'admin-1');
    expect(res.id).toBe('c1');
  });
});
