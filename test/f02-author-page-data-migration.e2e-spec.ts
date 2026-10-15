import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const MIGRATION = '20261015120000_f02_author_page_data';

/** Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. */
const statements = (): string[] =>
  readFileSync(join(__dirname, '../prisma/migrations', MIGRATION, 'migration.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((sql) => sql.trim())
    .filter(Boolean);

const NEW_AUTHOR_COLUMNS = ['nativeName', 'photoCredit'];
const NEW_TRANSLATION_COLUMNS = [
  'tagline',
  'facts',
  'notableWorks',
  'startHere',
  'timeline',
  'influences',
  'awards',
  'adaptations',
  'funFacts',
  'sources',
  'updatedAt',
];

/**
 * F02-2: миграция только добавляет колонки, а `AuthorTranslation.updatedAt` заполняет датой
 * сохранения автора (решение арбитра 15.10.2026, `F02 | F02-2`). e2e накатывает миграции на
 * уже мигрированную базу, поэтому прежнее состояние воспроизводится в отдельной схеме: копии
 * двух таблиц без новых колонок, миграция исполняется с `search_path` на эту схему.
 */
describe('F02-2 — миграция данных страницы автора (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const schemas: string[] = [];

  /** Схема с таблицами в форме до миграции; наполнение — по желанию теста. */
  const legacySchema = async (name: string): Promise<string> => {
    const schema = `f02_mig_${name}_${stamp}`;
    schemas.push(schema);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."Author" (LIKE public."Author" INCLUDING DEFAULTS)`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."AuthorTranslation" (LIKE public."AuthorTranslation" INCLUDING DEFAULTS)`,
    );
    for (const column of NEW_AUTHOR_COLUMNS) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."Author" DROP COLUMN "${column}"`);
    }
    for (const column of NEW_TRANSLATION_COLUMNS) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."AuthorTranslation" DROP COLUMN "${column}"`,
      );
    }
    return schema;
  };

  const migrate = (schema: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      for (const sql of statements()) await tx.$executeRawUnsafe(sql);
    });

  const columns = async (schema: string, table: string) =>
    prisma.$queryRawUnsafe<
      Array<{ column_name: string; is_nullable: string; column_default: string | null }>
    >(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      schema,
      table,
    );

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await moduleRef.close();
  });

  it('на пустых таблицах добавляет все колонки; дата перевода обязательна', async () => {
    const schema = await legacySchema('empty');
    await migrate(schema);

    const author = await columns(schema, 'Author');
    const translation = await columns(schema, 'AuthorTranslation');
    for (const name of NEW_AUTHOR_COLUMNS) {
      expect(author.find((c) => c.column_name === name)?.is_nullable).toBe('YES');
    }
    for (const name of NEW_TRANSLATION_COLUMNS.filter((c) => c !== 'updatedAt')) {
      expect(translation.find((c) => c.column_name === name)?.is_nullable).toBe('YES');
    }
    const updatedAt = translation.find((c) => c.column_name === 'updatedAt');
    expect(updatedAt?.is_nullable).toBe('NO');
    // Умолчание обязательно: прежний образ во время выката вставляет перевод без этой колонки.
    expect(updatedAt?.column_default).toMatch(/CURRENT_TIMESTAMP/i);
  });

  it('на заполненных: старые данные целы, новые блоки пусты, дата перевода — дата автора', async () => {
    const schema = await legacySchema('filled');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."Author" (id, "birthDate", "createdAt", "updatedAt")
       VALUES ('a1', '1828-09-09', '2026-01-01T00:00:00Z', '2026-05-05T10:00:00Z')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."AuthorTranslation" (id, "authorId", language, slug, name, biography, quotes)
       VALUES ('t1', 'a1', 'ru'::public."Language", 'lev-tolstoy', 'Лев Толстой', '<p>bio</p>',
               '[{"text":"q"}]'::jsonb)`,
    );

    await migrate(schema);
    // Повторный прогон ничего не ломает: `ADD COLUMN IF NOT EXISTS`, дата снова берётся у автора.
    await migrate(schema);

    const [row] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${schema}"."AuthorTranslation" WHERE id = 't1'`,
    );
    expect(row).toMatchObject({
      slug: 'lev-tolstoy',
      name: 'Лев Толстой',
      biography: '<p>bio</p>',
      quotes: [{ text: 'q' }],
      tagline: null,
      facts: null,
      startHere: null,
      sources: null,
    });
    expect((row.updatedAt as Date).toISOString()).toBe('2026-05-05T10:00:00.000Z');
    const [author] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${schema}"."Author" WHERE id = 'a1'`,
    );
    expect(author).toMatchObject({ birthDate: '1828-09-09', nativeName: null, photoCredit: null });
  });
});
