import type { Prisma } from '@prisma/client';

/**
 * Замок строки версии `FOR NO KEY UPDATE`: исключает `UPDATE` публикации, не мешает вставкам
 * дочерних строк по внешнему ключу. Берётся в той же транзакции, что запись или проверка перед
 * ней, - публикация идёт мимо замков пересказа, анализа и сравнения и иначе успела бы между
 * чтением и записью.
 */
export async function lockVersionRow(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bookVersionId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "BookVersion" WHERE "id" = ${bookVersionId} FOR NO KEY UPDATE`;
}
