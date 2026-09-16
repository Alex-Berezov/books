import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CLEARANCE_TX_OPTIONS, RightsClearanceLockService } from './rights-clearance-lock.service';

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
