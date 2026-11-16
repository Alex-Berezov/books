import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BOOK_WORLD_TX_OPTIONS, runInWorldTx } from './book-world-lock';

/**
 * F08-2: транзакция мира общая у записи и у пересчёта присутствия. Версию удалили каскадом между
 * чтением и записью — FK-отказ P2003 (create) или P2025 (update) становится 404, а не 500
 * и не «сбой пересчёта» с растущей паузой (R3).
 */
const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('gone', { code, clientVersion: 'test' });

const prismaFailing = (error: unknown) => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ status: 'draft' }) },
  };
  return {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
      throw error;
    }),
  } as unknown as Parameters<typeof runInWorldTx>[0];
};

describe('runInWorldTx (F08-2)', () => {
  it.each(['P2003', 'P2025'])('%s — версии нет: 404', async (code) => {
    await expect(
      runInWorldTx(prismaFailing(known(code)), 'v1', () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('другой отказ базы не превращается в 404', async () => {
    const error = known('P2002');
    await expect(runInWorldTx(prismaFailing(error), 'v1', () => Promise.resolve(1))).rejects.toBe(
      error,
    );
  });

  it('версии нет под замком — 404, колбэк не зовётся', async () => {
    const fn = jest.fn();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bookVersion: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: jest.fn((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as Parameters<typeof runInWorldTx>[0];
    await expect(runInWorldTx(prisma, 'v1', fn)).rejects.toBeInstanceOf(NotFoundException);
    expect(fn).not.toHaveBeenCalled();
  });

  it('транзакция идёт с явными timeout и maxWait (L-020): пересчёт пишет до 100 строк под замком', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bookVersion: { findUnique: jest.fn().mockResolvedValue({ status: 'draft' }) },
    };
    const $transaction = jest.fn((cb: (t: unknown) => Promise<unknown>) => cb(tx));
    const prisma = { $transaction } as unknown as Parameters<typeof runInWorldTx>[0];
    await runInWorldTx(prisma, 'v1', () => Promise.resolve(1));
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(($transaction.mock.calls[0] as unknown[])[1]).toBe(BOOK_WORLD_TX_OPTIONS);
    expect(BOOK_WORLD_TX_OPTIONS).toEqual({ timeout: 20_000, maxWait: 10_000 });
  });
});
