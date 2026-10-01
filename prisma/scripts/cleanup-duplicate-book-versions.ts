import { config } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

/*
  Cleanup duplicate (bookId, language) BookVersion rows keeping earliest createdAt.
  Usage:
    ts-node prisma/scripts/cleanup-duplicate-book-versions.ts            # dry run
    APPLY=1 ts-node prisma/scripts/cleanup-duplicate-book-versions.ts    # perform deletions
*/

/**
 * Владельцы строки `Seo` — обратные связи модели `Seo`, прочитанные из схемы. Скрипт живёт вне `src/`
 * и в образе запускается без него, поэтому `SEO_OWNER_RELATIONS` из `src/shared/seo/seo-orphan.util.ts`
 * сюда не импортируется; список из DMMF не расходится со схемой по построению.
 */
const seoOwnerRelations = (): string[] =>
  (Prisma.dmmf.datamodel.models.find((model) => model.name === 'Seo')?.fields ?? [])
    .filter((field) => field.kind === 'object')
    .map((field) => field.name);

/**
 * Дефолт Prisma (5 с / 2 с) рассчитан на пару операторов, а здесь на каждую версию группы идут замок,
 * чтение шести связей и удаление, плюс каскад глав при `deleteMany` (`L-020`).
 */
const DUPLICATE_CLEANUP_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

/**
 * Удаляет версии и их `Seo`, ставшие ничьими (`LEGACY-400`, пачка `T80`). `BookVersion.seoId` без каскада:
 * прежний `deleteMany` оставлял строки `Seo` сиротами, а их адресные колонки держат медиа от уборки
 * (`LEGACY-413`). Одна транзакция на группу, порядок тот же, что у `deleteSeoIfUnreferenced`: владелец
 * отпускает строку, затем строка `Seo` запирается и удаляется, только если её больше никто не держит —
 * одна строка `Seo` может принадлежать и сущности другой таблицы. Копия порядка из
 * `src/shared/seo/seo-orphan.util.ts` (скрипт идёт в образ без `src/`): правится вместе с ней.
 */
export async function deleteVersionsWithSeo(prisma: PrismaClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const owners = seoOwnerRelations();
  // Пустой список читался бы как «ничья» у любой строки и удалял бы `Seo` из-под живых владельцев.
  if (owners.length === 0) throw new Error('Seo owner relations not found in Prisma DMMF');
  await prisma.$transaction(async (tx) => {
    // Строки версий запираются до чтения `seoId`: встречная правка `BookVersionService.update`
    // между чтением и `deleteMany` дописала бы новый `seoId`, и его `Seo` осталась бы сиротой.
    // Порядок тот же, что у писателей: сначала строка версии, потом `Seo`.
    const versions = await tx.$queryRaw<{ seoId: number | null }[]>`
      SELECT "seoId" FROM "BookVersion" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    await tx.bookVersion.deleteMany({ where: { id: { in: ids } } });
    for (const { seoId } of versions) {
      if (seoId === null) continue;
      await tx.$queryRaw`SELECT id FROM "Seo" WHERE id = ${seoId} FOR UPDATE`;
      const seo: Record<string, unknown> | null = await tx.seo.findUnique({
        where: { id: seoId },
        select: Object.fromEntries(owners.map((owner) => [owner, { select: { id: true } }])),
      });
      if (seo && Object.values(seo).every((owner) => owner === null)) {
        await tx.seo.deleteMany({ where: { id: seoId } });
      }
    }
  }, DUPLICATE_CLEANUP_TX_OPTIONS);
}

async function main() {
  config();
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  const apply = process.env.APPLY === '1';

  const duplicates = await prisma.$queryRaw<{ bookId: string; language: string; ids: string[] }[]>`
    SELECT "bookId", "language", ARRAY_AGG(id ORDER BY "createdAt") AS ids
    FROM "BookVersion"
    GROUP BY "bookId", "language"
    HAVING COUNT(*) > 1
  `;

  if (duplicates.length === 0) {
    console.log('No duplicates found.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${duplicates.length} duplicate key groups`);
  for (const d of duplicates) {
    const keep = d.ids[0];
    const remove = d.ids.slice(1);
    console.log(
      `Group bookId=${d.bookId} language=${d.language} -> keep ${keep}, remove ${remove.join(',')}`,
    );
    if (apply) {
      await deleteVersionsWithSeo(prisma, remove);
    }
  }
  if (apply) {
    console.log('Deletions applied.');
  } else {
    console.log('Dry run complete. Set APPLY=1 to delete.');
  }
  await prisma.$disconnect();
}

// Запуск только как скрипта: e2e импортирует `deleteVersionsWithSeo`, не трогая базу из окружения.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
