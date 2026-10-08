import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Вторая миграция (T118, решение арбитра V1) повторяет первую, закрывая окно выката, когда
 * старый образ ещё писал адреса как пришли; обе обязаны вести себя одинаково.
 */
const MIGRATIONS = [
  '20261008120000_legacy_443_lowercase_email',
  '20261008180000_legacy_443_lowercase_email_repeat',
];

/** Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. */
const statements = (migration: string): string[] =>
  readFileSync(join(__dirname, '../prisma/migrations', migration, 'migration.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((sql) => sql.trim())
    .filter(Boolean);

/**
 * 🔴 `LEGACY-443`, решения арбитра B2 и V1 (08.10.2026). До T117 адрес хранился как пришёл, и
 * `Boss@x.com` с `boss@x.com` были двумя аккаунтами. Миграция приводит к `lower(btrim())` только
 * строки без коллизий, а коллизии оставляет как есть и пишет в `_legacy443_email_collisions`.
 * e2e накатывает миграции на пустую базу, поэтому здесь её SQL исполняется заново по строкам,
 * которые оставил старый путь.
 */
describe.each(MIGRATIONS)(
  'LEGACY-443 — приведение User.email к нижнему регистру, %s (e2e)',
  (migration) => {
    let moduleRef: TestingModule;
    let prisma: PrismaService;
    // Свой штамп на каждую миграцию: оба набора собираются в одну миллисекунду.
    const stamp = Date.now() + MIGRATIONS.indexOf(migration);
    const ids: Record<string, string> = {};

    const run = async (): Promise<void> => {
      for (const sql of statements(migration)) await prisma.$executeRawUnsafe(sql);
    };
    const emailOf = async (key: string): Promise<string> =>
      (await prisma.user.findUniqueOrThrow({ where: { id: ids[key] }, select: { email: true } }))
        .email;
    const journal = async (): Promise<Array<{ userId: string; normalizedEmail: string }>> =>
      prisma.$queryRawUnsafe(
        `SELECT "userId", "normalizedEmail" FROM "_legacy443_email_collisions" WHERE "userId" = ANY($1) ORDER BY "userId"`,
        Object.values(ids),
      );

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      prisma = moduleRef.get(PrismaService);
      await moduleRef.init();

      const make = async (key: string, email: string) => {
        const user = await prisma.user.create({
          data: { email, languagePreference: Language.en },
          select: { id: true },
        });
        ids[key] = user.id;
      };
      await make('mixed', `L443-Mixed-${stamp}@Example.COM`);
      await make('spaced', `  l443-spaced-${stamp}@example.com `);
      await make(
        'tabbed',
        `	L443-Tab-${stamp}@example.com
`,
      );
      await make('lower', `l443-lower-${stamp}@example.com`);
      await make('pairUpper', `L443-PAIR-${stamp}@example.com`);
      await make('pairLower', `l443-pair-${stamp}@example.com`);

      await run();
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "_legacy443_email_collisions" WHERE "userId" = ANY($1)`,
        Object.values(ids),
      );
      await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
      await moduleRef.close();
    });

    it('адрес в смешанном регистре и с пробелами приводится к нижнему без пробелов', async () => {
      expect(await emailOf('mixed')).toBe(`l443-mixed-${stamp}@example.com`);
      expect(await emailOf('spaced')).toBe(`l443-spaced-${stamp}@example.com`);
      // Таб и перевод строки по краям срезает и `String.trim()` в `normalizeEmail` - формы совпадают.
      expect(await emailOf('tabbed')).toBe(`l443-tab-${stamp}@example.com`);
      expect(await emailOf('lower')).toBe(`l443-lower-${stamp}@example.com`);
    });

    it('пара, сходящаяся после приведения, не тронута и записана в журнал обеими строками', async () => {
      expect(await emailOf('pairUpper')).toBe(`L443-PAIR-${stamp}@example.com`);
      expect(await emailOf('pairLower')).toBe(`l443-pair-${stamp}@example.com`);
      const rows = await journal();
      expect(rows.map((r) => r.userId).sort()).toEqual([ids.pairLower, ids.pairUpper].sort());
      for (const row of rows) expect(row.normalizedEmail).toBe(`l443-pair-${stamp}@example.com`);
    });

    it('повторный прогон ничего не меняет и журнал не дублирует', async () => {
      await run();
      expect(await emailOf('mixed')).toBe(`l443-mixed-${stamp}@example.com`);
      expect(await emailOf('pairUpper')).toBe(`L443-PAIR-${stamp}@example.com`);
      expect(await journal()).toHaveLength(2);
    });
  },
);
