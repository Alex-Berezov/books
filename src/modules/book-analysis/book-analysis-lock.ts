import { Prisma } from '@prisma/client';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_ANALYSIS_LOCK_NAMESPACE = 831_427_006;
// Явные границы (`L-020`): писатель, дождавшийся замка, не должен падать P2028 на дефолтных 5 секундах.
export const BOOK_ANALYSIS_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Замок анализа версии на транзакции: «прочитал — слил — записал» импорта (`saveForVersion`) и
 * данные хода анализа `F07` (`ContentDraft` вида `analysis_write`) идут под одним замком — решение
 * хода «записать или предложить» читает блоки под тем же замком, что запись (`L-019`).
 */
export async function lockBookAnalysis(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT true AS locked
    FROM pg_advisory_xact_lock(${BOOK_ANALYSIS_LOCK_NAMESPACE}::int4, hashtext(${bookVersionId}::text))`;
}
