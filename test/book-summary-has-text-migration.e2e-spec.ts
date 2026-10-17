import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261017120000_book_summary_has_text/migration.sql',
);

/** Оператор пересчёта из миграции - ровно тот текст, который исполнится при выкате. */
const backfill = (): string => {
  const sql = readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .find((s) => s.startsWith('UPDATE'));
  if (!sql) throw new Error('В миграции нет оператора UPDATE');
  return sql;
};

/**
 * Раздел «Пересказ» (решение арбитра 17.10.2026): миграция `hasText` пересчитывает строки,
 * сохранённые до валидатора. SQL-приближение `richHtmlText` проверяется на живом Postgres
 * по формам из ревью: пустые получают false, строка с текстом остаётся true.
 */
describe('BookSummary.hasText - пересчёт старых строк миграцией (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const bookIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    await prisma?.book.deleteMany({ where: { id: { in: bookIds } } });
    await moduleRef?.close();
  });

  const EMPTY = [
    '',
    '   ',
    '<p></p>',
    '<p><br /></p>',
    '<p>&nbsp;</p>',
    '<p> </p>',
    '<h2></h2><p></p>',
    '<h2> </h2><p><br></p>',
    '<p>&#8203;</p>',
    '<p>&#x200b;</p>',
    '<p>&#x200B;&ensp;&#160;&#0160;</p>',
    '<p>\u00a0\u200b\ufeff</p>',
    '<script>alert(1)</script>',
    '<p>&#8200;&#x2008;&#12288;&#8239;&#x2028;&#5760;</p>',
    '<p>\u2028\u2029\u1680</p>',
  ];
  // Текст между двумя вырезаемыми блоками: жадное выражение съело бы его вместе со скриптами.
  const WITH_TEXT = [
    '<p>Призрак отца является Гамлету.</p>',
    '<p>&#1040;</p>',
    '<p>&amp;</p>',
    '<p>&nbsp;Текст</p>',
    '<script>a</script><p>Текст</p><script>b</script>',
    '<style>a{}</style><p>Текст</p><style>b{}</style>',
  ];

  it('пустые формы получают hasText=false, строки с текстом остаются true', async () => {
    const ids = new Map<string, string>();
    for (const [index, summary] of [...EMPTY, ...WITH_TEXT].entries()) {
      const book = await createBookFixture(prisma, `sum-has-text-${stamp}-${index}`);
      bookIds.push(book.id);
      const version = await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language: 'en',
          title: `Has text ${index}`,
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'published',
        },
      });
      const row = await prisma.bookSummary.create({
        data: { bookVersionId: version.id, summary, hasText: true },
      });
      ids.set(summary, row.id);
    }

    await prisma.$executeRawUnsafe(backfill());

    for (const summary of EMPTY) {
      const row = await prisma.bookSummary.findUniqueOrThrow({ where: { id: ids.get(summary) } });
      expect({ summary, hasText: row.hasText }).toEqual({ summary, hasText: false });
    }
    for (const summary of WITH_TEXT) {
      const row = await prisma.bookSummary.findUniqueOrThrow({ where: { id: ids.get(summary) } });
      expect({ summary, hasText: row.hasText }).toEqual({ summary, hasText: true });
    }
  });
});
