import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

/*
  Cleanup duplicate (bookId, language) BookVersion rows keeping earliest createdAt.
  Usage:
    ts-node prisma/scripts/cleanup-duplicate-book-versions.ts            # dry run
    APPLY=1 ts-node prisma/scripts/cleanup-duplicate-book-versions.ts    # perform deletions
*/
async function main() {
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
      await prisma.bookVersion.deleteMany({ where: { id: { in: remove } } });
    }
  }
  if (apply) {
    console.log('Deletions applied.');
  } else {
    console.log('Dry run complete. Set APPLY=1 to delete.');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
