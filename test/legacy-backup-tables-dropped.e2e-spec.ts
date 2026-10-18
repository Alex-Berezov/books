import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { tableExists } from './helpers/table-exists';

/**
 * 🔴 `T106` (`LEGACY-400`, `LEGACY-429`, `LEGACY-436`). Резервные таблицы отката сняты миграцией
 * `20261018120000_t106_drop_legacy_backup_tables`: после всех миграций их быть не должно. Спеки
 * старых миграций создают эти таблицы сами и снимают их, только если цепочка миграций их не оставила
 * (`helpers/table-exists.ts`), поэтому проба видит ровно то, что оставила цепочка, при любом порядке
 * наборов в воркере.
 */
const DROPPED_TABLES = [
  '_legacy429_comment_text',
  '_legacy400_person_seo',
  '_legacy400_orphan_seo',
  '_legacy436_backfill',
];

describe('T106 — резервные таблицы отката сняты (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  // Положительный контроль: без него вечный `false` хелпера зеленил бы пробу и без миграции `T106`.
  it('хелпер видит существующую таблицу', async () => {
    const probe = `_t106_probe_${process.pid}`;
    await prisma.$executeRawUnsafe(`CREATE TABLE "${probe}" ("id" INTEGER)`);
    try {
      expect(await tableExists(prisma, probe)).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${probe}"`);
    }
  });

  it.each(DROPPED_TABLES)('таблицы %s нет после всех миграций', async (table) => {
    expect(await tableExists(prisma, table)).toBe(false);
  });
});
