import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CLEARANCE_TX_OPTIONS,
  LockedClearanceScope,
  RightsClearanceLockService,
} from './rights-clearance-lock.service';

type Version = { rightsProfileId: string | null; approvedRightsReviewId: string | null } | null;

const createPrisma = (version: Version) => {
  const tx = {
    bookVersion: { findUnique: jest.fn().mockResolvedValue(version) },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
  };
  const prisma = {
    // Второй аргумент — опции транзакции; тест читает его из `mock.calls`.
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>, ...options: unknown[]) =>
      options.length > 0 ? fn(tx) : Promise.reject(new Error('transaction without options')),
    ),
  };
  return { tx, prisma };
};

/** Пространство имён и ключ каждого взятого замка, в порядке взятия. */
const lockedKeys = (tx: ReturnType<typeof createPrisma>['tx']): Array<[unknown, unknown]> =>
  tx.$queryRaw.mock.calls.map((call: unknown[]) => {
    const sql = call[0] as TemplateStringsArray;
    expect(sql.join('?')).toContain('pg_advisory_xact_lock(');
    return [call[1], call[2]];
  });

/**
 * `LEGACY-368`: обёртка сама открывает транзакцию с дедлайном под ожидание замка, берёт замок
 * первым оператором и только потом отдаёт `tx`. Порядок ключей один на всех писателей —
 * сначала профиль, потом проверка прав: обратный порядок у одного из них вернул бы цикл.
 */
describe('RightsClearanceLockService', () => {
  const run = async (version: Version) => {
    const { tx, prisma } = createPrisma(version);
    const service = new RightsClearanceLockService(prisma as unknown as PrismaService);
    const work = jest.fn((client: Prisma.TransactionClient) => {
      expect(client).toBe(tx);
      return Promise.resolve('done');
    });
    const result = await service.runInLockedClearance('v1', work);
    return { tx, prisma, work, result };
  };

  it('opens one transaction with the lock deadline and hands its tx to the work', async () => {
    const { prisma, work, result } = await run({
      rightsProfileId: 'p1',
      approvedRightsReviewId: 'r1',
    });

    expect(result).toBe('done');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30_000, maxWait: 10_000 });
    expect(CLEARANCE_TX_OPTIONS).toEqual({ timeout: 30_000, maxWait: 10_000 });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('locks the profile before the review, each in its own namespace, before the work', async () => {
    const { tx, work } = await run({ rightsProfileId: 'p1', approvedRightsReviewId: 'r1' });

    const keys = lockedKeys(tx);
    expect(keys.map(([, id]) => id)).toEqual(['p1', 'r1']);
    expect(keys[0][0]).not.toBe(keys[1][0]);
    expect(tx.bookVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.bookVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'v1' },
      select: { rightsProfileId: true, approvedRightsReviewId: true },
    });
    const [readOrder] = tx.bookVersion.findUnique.mock.invocationCallOrder;
    const [firstLock, secondLock] = tx.$queryRaw.mock.invocationCallOrder;
    const [workOrder] = work.mock.invocationCallOrder;
    expect(readOrder).toBeLessThan(firstLock);
    expect(secondLock).toBeLessThan(workOrder);
  });

  it('same key gets the same namespace whichever version holds it', async () => {
    const a = await run({ rightsProfileId: 'p1', approvedRightsReviewId: 'r1' });
    const b = await run({ rightsProfileId: 'p1', approvedRightsReviewId: 'r2' });

    expect(lockedKeys(a.tx)[0]).toEqual(lockedKeys(b.tx)[0]);
  });

  it('skips a null profile and still locks the review', async () => {
    const { tx } = await run({ rightsProfileId: null, approvedRightsReviewId: 'r1' });

    expect(lockedKeys(tx).map(([, id]) => id)).toEqual(['r1']);
  });

  it('skips a null review and still locks the profile', async () => {
    const { tx } = await run({ rightsProfileId: 'p1', approvedRightsReviewId: null });

    expect(lockedKeys(tx).map(([, id]) => id)).toEqual(['p1']);
  });

  it('takes no lock but still runs the work when there is no group or no version', async () => {
    const bare = await run({ rightsProfileId: null, approvedRightsReviewId: null });
    const missing = await run(null);

    expect(bare.tx.$queryRaw).not.toHaveBeenCalled();
    expect(missing.tx.$queryRaw).not.toHaveBeenCalled();
    expect(bare.work).toHaveBeenCalledTimes(1);
    expect(missing.work).toHaveBeenCalledTimes(1);
  });
});

/**
 * `LEGACY-368` (T33): пересчёт по персоне и по профилю помечает версии нескольких групп в одной
 * транзакции. Посадка — на форму захвата: транзакцию открывает сам замок с дедлайном
 * `CLEARANCE_TX_OPTIONS`, ключи групп берёт по возрастанию ключа замка (профили, потом проверки
 * прав), затем строки всех версий этих групп одним `FOR NO KEY UPDATE` по `id` — и только потом
 * отдаёт телу `tx` и запертый набор. Без замка строк фан-ауты разных версий трогают общих соседей
 * не одним списком — цикл со встречной правкой главы непересекающейся группы.
 */
describe('RightsClearanceLockService.runInLockedClearanceScope', () => {
  const HASH: Record<string, number> = { p1: 30, p2: 10, r1: 20, r2: 5 };
  type Group = { rightsProfileId: string | null; approvedRightsReviewId: string | null };

  const createPrisma = (versions: Group[]) => {
    const tx = {
      bookVersion: { findMany: jest.fn().mockResolvedValue(versions) },
      $queryRaw: jest.fn((sql: TemplateStringsArray, ...values: unknown[]) => {
        if (sql.join('?').includes('unnest(')) {
          const ids = values[0] as string[];
          const keys = [...new Set(ids.map((id) => HASH[id]))].sort((x, y) => x - y);
          return Promise.resolve(keys.map((key) => ({ key })));
        }
        return Promise.resolve([]);
      }),
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>, ...options: unknown[]) =>
        options.length > 0 ? fn(tx) : Promise.reject(new Error('transaction without options')),
      ),
    };
    return { tx, prisma };
  };

  const statements = (tx: ReturnType<typeof createPrisma>['tx']) =>
    tx.$queryRaw.mock.calls.map((call: unknown[]) => ({
      sql: (call[0] as TemplateStringsArray).join('?'),
      values: call.slice(1),
    }));

  const run = async (versionIds: string[], versions: Group[]) => {
    const { tx, prisma } = createPrisma(versions);
    const service = new RightsClearanceLockService(prisma as unknown as PrismaService);
    const resolve = jest.fn((client: Prisma.TransactionClient) => {
      expect(client).toBe(tx);
      return Promise.resolve(versionIds);
    });
    const work = jest.fn((client: Prisma.TransactionClient, scope: LockedClearanceScope) => {
      expect(client).toBe(tx);
      return Promise.resolve(scope);
    });
    const scope = await service.runInLockedClearanceScope(resolve, work);
    return { tx, prisma, resolve, work, scope, calls: statements(tx) };
  };

  it('opens one transaction with the lock deadline and runs resolve and work once each', async () => {
    const { prisma, resolve, work } = await run(
      ['v1'],
      [{ rightsProfileId: 'p1', approvedRightsReviewId: 'r1' }],
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual(CLEARANCE_TX_OPTIONS);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('locks profile keys, then review keys, each ascending by lock key, then the version rows', async () => {
    const { calls, tx } = await run(
      ['v2', 'v1', 'v3'],
      [
        { rightsProfileId: 'p1', approvedRightsReviewId: 'r1' },
        { rightsProfileId: 'p2', approvedRightsReviewId: 'r2' },
        { rightsProfileId: 'p1', approvedRightsReviewId: null },
      ],
    );

    expect(tx.bookVersion.findMany).toHaveBeenCalledTimes(1);
    expect(tx.bookVersion.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['v2', 'v1', 'v3'] } },
      select: { rightsProfileId: true, approvedRightsReviewId: true },
    });

    const locks = calls.filter((c) => c.sql.includes('pg_advisory_xact_lock('));
    // Порядок — по ключу замка (p2=10 < p1=30; r2=5 < r1=20), а не по строке id.
    expect(locks.map((c) => c.values[1])).toEqual([10, 30, 5, 20]);
    expect(locks[0].values[0]).toBe(locks[1].values[0]);
    expect(locks[2].values[0]).toBe(locks[3].values[0]);
    expect(locks[0].values[0]).not.toBe(locks[2].values[0]);

    const rowLocks = calls.filter((c) => c.sql.includes('FOR NO KEY UPDATE'));
    expect(rowLocks).toHaveLength(1);
    const [rowLock] = rowLocks;
    expect(rowLock.sql).toContain('FROM "BookVersion"');
    expect(rowLock.sql).toContain('ORDER BY id');
    expect(rowLock.values).toEqual([
      ['v2', 'v1', 'v3'],
      ['p1', 'p2'],
      ['r1', 'r2'],
    ]);
    expect(calls[calls.length - 1]).toBe(rowLock);
  });

  it('takes every lock before the work and hands it the deduplicated set it locked', async () => {
    const { tx, work, scope } = await run(
      ['v1', 'v1', 'v2'],
      [{ rightsProfileId: 'p1', approvedRightsReviewId: null }],
    );

    expect(scope.versionIds).toEqual(['v1', 'v2']);
    const lastLock = Math.max(...tx.$queryRaw.mock.invocationCallOrder);
    const [workOrder] = work.mock.invocationCallOrder;
    expect(lastLock).toBeLessThan(workOrder);
  });

  it('takes no lock and touches no row for an empty set, but still runs the work', async () => {
    const { scope, tx, work } = await run([], []);

    expect(scope.versionIds).toEqual([]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.bookVersion.findMany).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);
  });

  /**
   * Оба пути берут замки групп одним помощником. На одной группе многогрупповой путь обязан
   * запереть ровно то же и в том же порядке, что и путь одной версии: разойдись они — встречные
   * транзакции двух путей возьмут общие ключи крест-накрест.
   */
  it('locks one group exactly like the single-version path does', async () => {
    const group = { rightsProfileId: 'p1', approvedRightsReviewId: 'r1' };
    const scopePath = await run(['v1'], [group]);

    const single = createPrisma([]);
    const singleTx = {
      bookVersion: { findUnique: jest.fn().mockResolvedValue(group) },
      $queryRaw: single.tx.$queryRaw,
    };
    const service = new RightsClearanceLockService({
      $transaction: jest.fn((fn: (client: typeof singleTx) => Promise<unknown>) => fn(singleTx)),
    } as unknown as PrismaService);
    await service.runInLockedClearance('v1', () => Promise.resolve());

    const advisory = (calls: Array<{ sql: string; values: unknown[] }>) =>
      calls.filter((c) => c.sql.includes('pg_advisory_xact_lock(')).map((c) => c.values);
    expect(advisory(scopePath.calls)).toEqual(advisory(statements(single.tx)));
    expect(advisory(scopePath.calls).map(([, id]) => id)).toEqual(['p1', 'r1']);
  });

  it('still locks the rows of versions without any group', async () => {
    const { calls } = await run(['v1'], [{ rightsProfileId: null, approvedRightsReviewId: null }]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('FOR NO KEY UPDATE');
  });
});
