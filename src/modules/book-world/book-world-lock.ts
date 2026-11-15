import { Prisma } from '@prisma/client';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_WORLD_LOCK_NAMESPACE = 831_427_008;
// Явные границы (`L-020`): писатель, дождавшийся замка, не должен падать P2028 на дефолтных 5 секундах.
// `timeout` короче, чем у публикации версии (`BOOK_VERSION_VISIBILITY_TX_OPTIONS`, 30 с): запись мира
// держит замок строки версии, и публикация, ждущая его, дождётся конца самой долгой записи мира
// раньше своего дедлайна. Тяжёлое (главы, дословность цитат) идёт до транзакции.
export const BOOK_WORLD_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/**
 * Замок мира книги версии на транзакции: «прочитал — слил — записал» импорта версии и сущности,
 * удаление, отметки «прочитано» и флаги идут в одну очередь, поэтому сверка `expectedUpdatedAt`
 * по всей версии и проверка ссылок на слитом наборе не теряют запись второго писателя.
 */
export async function lockBookWorld(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT true AS locked
    FROM pg_advisory_xact_lock(${BOOK_WORLD_LOCK_NAMESPACE}::int4, hashtext(${bookVersionId}::text))`;
}
