import { Prisma } from '@prisma/client';
import { RightsClearanceLockService } from '../../modules/rights-intake/rights-clearance-lock.service';

/**
 * Подмена `RightsClearanceLockService` для спек писателей (`LEGACY-368`): отдаёт колбэку
 * переданный клиент стенда и помнит, открыта ли сейчас «транзакция под замком». Спека пишет
 * в свой мок записи `fake.isLocked()` в момент вызова — так проверяется, что запись идёт
 * внутри обёртки, а не рядом с ней.
 *
 * `options.transaction` — стенд со своим `$transaction`: колбэк идёт через него, как у настоящего
 * замка, открывающего транзакцию (спеки атомарности пометки без `tx`, T56). Без него колбэк
 * получает `tx` напрямую.
 */
export interface ClearanceLockFake {
  service: RightsClearanceLockService;
  lockedVersions: string[];
  isLocked(): boolean;
}

export type TransactionStand = {
  $transaction: (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>;
};

export const createClearanceLockFake = (
  tx: unknown,
  options: { transaction?: TransactionStand } = {},
): ClearanceLockFake => {
  const lockedVersions: string[] = [];
  let depth = 0;
  const fake = {
    async runInLockedClearance<T>(
      versionId: string,
      fn: (client: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      lockedVersions.push(versionId);
      depth += 1;
      try {
        if (options.transaction) return (await options.transaction.$transaction(fn)) as T;
        return await fn(tx as Prisma.TransactionClient);
      } finally {
        depth -= 1;
      }
    },
  };
  return {
    service: fake as unknown as RightsClearanceLockService,
    lockedVersions,
    isLocked: () => depth > 0,
  };
};
