import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_SUMMARY_LOCK_NAMESPACE = 831_427_004;
// Явные границы (`L-020`): писатель, дождавшийся замка, не должен падать P2028 на дефолтных 5 секундах.
const BOOK_SUMMARY_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Транзакция под замком пересказа версии. Один замок на полный пересказ, очень краткий и разделы
 * (F04 T4-T5): номера разделов перечитываются только под ним, и два параллельных удаления не
 * сдвигают номера по устаревшему чтению.
 */
export function withSummaryLock<T>(
  prisma: PrismaService,
  bookVersionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT true AS locked
      FROM pg_advisory_xact_lock(${BOOK_SUMMARY_LOCK_NAMESPACE}::int4, hashtext(${bookVersionId}::text))`;
    return fn(tx);
  }, BOOK_SUMMARY_TX_OPTIONS);
}

/**
 * Версию проверяли до транзакции и без замка, а её удаление идёт мимо замка пересказа: удалённая
 * в этом окне версия даёт FK-отказ на create (P2003) или снятую каскадом строку на update (P2025).
 */
export function isVersionGoneError(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2003' || e.code === 'P2025')
  );
}

/**
 * Запись под замком пересказа версии — одна на полный пересказ, очень краткий и разделы. Удалённая
 * посреди записи версия (P2003/P2025) — 404, а не 500.
 */
export async function writeUnderSummaryLock<T>(
  prisma: PrismaService,
  bookVersionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await withSummaryLock(prisma, bookVersionId, fn);
  } catch (e: unknown) {
    if (isVersionGoneError(e)) throw new NotFoundException('BookVersion not found');
    throw e;
  }
}
