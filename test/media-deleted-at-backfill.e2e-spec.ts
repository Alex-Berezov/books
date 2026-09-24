import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20260924180000_legacy_421_media_asset_deleted_at_backfill/migration.sql',
);

/**
 * 🔴 `LEGACY-421`, решение арбитра M1. До правки ручной `DELETE /media/:id` помечал ассет без
 * `deletedAt`, и stage 2 уборки такую строку не выбирал никогда. Миграция заполняет дату; здесь
 * её SQL исполняется на живом Postgres по строкам, которые оставил старый путь.
 */
describe('LEGACY-421 — заполнение deletedAt у помеченных ассетов (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const keys = {
    stale: `e2e-backfill-${stamp}/stale.webp`,
    dated: `e2e-backfill-${stamp}/dated.webp`,
    live: `e2e-backfill-${stamp}/live.webp`,
  };
  const earlier = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    await prisma?.mediaAsset.deleteMany({ where: { key: { in: Object.values(keys) } } });
    await moduleRef?.close();
  });

  it('dates rows marked without deletedAt and leaves dated and live rows alone', async () => {
    await prisma.mediaAsset.createMany({
      data: [
        { key: keys.stale, url: `https://cdn.example/${keys.stale}`, isDeleted: true },
        {
          key: keys.dated,
          url: `https://cdn.example/${keys.dated}`,
          isDeleted: true,
          deletedAt: earlier,
        },
        { key: keys.live, url: `https://cdn.example/${keys.live}` },
      ],
    });

    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));

    const rows = await prisma.mediaAsset.findMany({
      where: { key: { in: Object.values(keys) } },
      select: { key: true, deletedAt: true },
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.deletedAt]));
    expect(byKey[keys.stale]).toBeInstanceOf(Date);
    expect(byKey[keys.dated]).toEqual(earlier);
    expect(byKey[keys.live]).toBeNull();
  });
});
