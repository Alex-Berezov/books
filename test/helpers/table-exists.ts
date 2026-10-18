import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Есть ли в схеме `public` таблица с таким именем. Нужен спекам старых миграций, чьи резервные
 * таблицы сняты пачкой `T106`: спека создаёт таблицу сама и снимает её, только если цепочка
 * миграций её не оставила, — иначе проба `legacy-backup-tables-dropped` зависела бы от порядка
 * наборов в воркере.
 */
export const tableExists = async (prisma: PrismaService, table: string): Promise<boolean> => {
  const [row] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass(${`public."${table}"`}) IS NOT NULL AS "exists"`;
  return row.exists;
};
