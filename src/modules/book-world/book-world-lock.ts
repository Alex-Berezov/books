import { NotFoundException } from '@nestjs/common';
import { Prisma, PublicationStatus } from '@prisma/client';
import { lockVersionRow } from '../translation/version-lock';

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

export type WorldVersionState = { status: PublicationStatus };

/**
 * Транзакция записи мира — одна на запись сущности, отметки, удаление и пересчёт присутствия
 * (F08-2). Порядок замков один: замок мира версии, затем строка версии (`lockVersionRow`), затем
 * строки сущностей. Публикация берёт строку версии, затем строки сущностей
 * (`stampWorldFirstPublished`); «прочитано» T184 — только строку версии. Замка мира никто не берёт
 * после строки версии, строк сущностей никто не держит до неё — цикла нет. Версию удалили — 404
 * (в том числе каскадом между чтением и записью: FK-отказ P2003 на create, P2025 на update).
 */
export async function runInWorldTx<T>(
  prisma: Pick<Prisma.TransactionClient, never> & {
    $transaction: <R>(
      fn: (tx: Prisma.TransactionClient) => Promise<R>,
      options?: { timeout?: number; maxWait?: number },
    ) => Promise<R>;
  },
  bookVersionId: string,
  fn: (tx: Prisma.TransactionClient, version: WorldVersionState) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockBookWorld(tx, bookVersionId);
      await lockVersionRow(tx, bookVersionId);
      const version = await tx.bookVersion.findUnique({
        where: { id: bookVersionId },
        select: { status: true },
      });
      if (!version) throw new NotFoundException('BookVersion not found');
      return fn(tx, version);
    }, BOOK_WORLD_TX_OPTIONS);
  } catch (e: unknown) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      (e.code === 'P2003' || e.code === 'P2025')
    ) {
      throw new NotFoundException('BookVersion not found');
    }
    throw e;
  }
}
