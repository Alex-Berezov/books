import { Prisma } from '@prisma/client';

/**
 * Очередь пересчёта присутствия мира книги (решение арбитра `F08 | F08-2` Q1): строка на версию.
 * Ставится в транзакции правки главы и записи или удаления сущности, без замков мира; у версии
 * без сущностей мира строка не ставится. Каждая постановка берёт новый `generation` из
 * последовательности базы — монотонный и после снятия строки, и при нескольких экземплярах: планировщик
 * снимает строку только при том `generation`, что взял, поэтому правка во время подсчёта не
 * теряется даже в ту же миллисекунду (`dirtyAt` — только порядок и пауза; решение арбитра R1).
 * Новая постановка сбрасывает счёт неудачных попыток (R3). Возвращает, поставлена ли строка:
 * `false` у версии без сущностей (по нему ответ записи сущности отдаёт `recountQueued`, S5).
 */
export async function markWorldMentionsDirty(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  bookVersionId: string,
): Promise<boolean> {
  const rows = await tx.$executeRaw`INSERT INTO "WorldMentionsPending" ("bookVersionId", "dirtyAt")
    SELECT ${bookVersionId}, (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE EXISTS (SELECT 1 FROM "BookWorldEntity" WHERE "bookVersionId" = ${bookVersionId})
    ON CONFLICT ("bookVersionId") DO UPDATE
      SET "dirtyAt" = EXCLUDED."dirtyAt",
        "generation" = nextval(pg_get_serial_sequence('"WorldMentionsPending"', 'generation')),
        "attempts" = 0`;
  return rows > 0;
}

/** Стоит ли у версии строка очереди пересчёта: метка «presence will update» во вкладке World (S5). */
export async function isWorldRecountPending(
  client: Pick<Prisma.TransactionClient, 'worldMentionsPending'>,
  bookVersionId: string,
): Promise<boolean> {
  const row = await client.worldMentionsPending.findUnique({
    where: { bookVersionId },
    select: { bookVersionId: true },
  });
  return row !== null;
}

/** Пауза после неудачного пересчёта (R3): 15 с, удваивается с каждой попыткой, не больше часа. */
export const WORLD_MENTIONS_RETRY_BASE_S = 15;
export const WORLD_MENTIONS_RETRY_MAX_S = 3600;

/**
 * Подсчёт версии упал с ошибкой (R3; сдвиг текста — `requeueWorldMentions`, R3a): строка
 * остаётся, следующая попытка — через нарастающую паузу часами базы, как постановка. Только при взятом `generation`:
 * правка во время подсчёта уже сбросила паузу и счёт попыток.
 */
export async function deferWorldMentions(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  taken: { bookVersionId: string; generation: number },
): Promise<void> {
  await client.$executeRaw`UPDATE "WorldMentionsPending"
    SET "dirtyAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        + LEAST(
          ${WORLD_MENTIONS_RETRY_BASE_S}::float8 * power(2, LEAST("attempts", 20)),
          ${WORLD_MENTIONS_RETRY_MAX_S}::float8
        )
          * interval '1 second',
      "attempts" = "attempts" + 1
    WHERE "bookVersionId" = ${taken.bookVersionId} AND "generation" = ${taken.generation}`;
}

/**
 * Текст или сущность сдвинулись во время подсчёта (решение арбитра `F08 | F08-2` R3a): строка
 * встаёт на обычную осадку от часов базы, `attempts` и `generation` прежние — это не сбой, а
 * запись редактора. Только при взятом `generation`: новая постановка своё уже сделала.
 */
export async function requeueWorldMentions(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  taken: { bookVersionId: string; generation: number },
): Promise<void> {
  await client.$executeRaw`UPDATE "WorldMentionsPending"
    SET "dirtyAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "bookVersionId" = ${taken.bookVersionId} AND "generation" = ${taken.generation}`;
}

/** Осевшие строки очереди: последняя постановка не позже `settleMs` назад по часам базы. */
export function dueWorldMentions(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  settleMs: number,
  limit: number,
): Promise<{ bookVersionId: string; generation: number }[]> {
  return client.$queryRaw<{ bookVersionId: string; generation: number }[]>`
    SELECT "bookVersionId", "generation" FROM "WorldMentionsPending"
    WHERE "dirtyAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - ${settleMs}::int * interval '1 millisecond'
    ORDER BY "dirtyAt" ASC LIMIT ${limit}::int`;
}
