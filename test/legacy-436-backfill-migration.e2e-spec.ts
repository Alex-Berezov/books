import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261004200000_legacy_436_backfill_translation_seo/migration.sql',
);

/** Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. */
const statements = (): string[] =>
  readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((sql) => sql.trim())
    .filter(Boolean);

/** Рецепт отката из шапки миграции — ровно тот текст, который исполнят после выката. */
const rollback = (): string[] =>
  readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => /^-- (UPDATE|DELETE) /.test(line))
    .map((line) => line.replace(/^-- /, '').replace(/;$/, ''));

/**
 * 🔴 `LEGACY-436`, `T100` (решение арбитра 04.10.2026). Миграция переносит плоские meta/OG перевода
 * тега и категории в `Seo`: только в пустые поля, без чужих строк `Seo`, с журналом для отката.
 * SQL исполняется на живом Postgres по строкам, которые оставили писатели до правки.
 */
describe('LEGACY-436 — перенос плоских meta/OG перевода в Seo (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const tagIds: string[] = [];
  const categoryIds: string[] = [];
  const seoIds: number[] = [];
  let pageId = '';

  const run = async () => {
    for (const sql of statements()) await prisma.$executeRawUnsafe(sql);
  };
  const seoOfTag = async (id: string) =>
    (await prisma.tagTranslation.findUniqueOrThrow({ where: { id }, include: { seo: true } })).seo;
  const seoOfCategory = async (id: string) =>
    (await prisma.categoryTranslation.findUniqueOrThrow({ where: { id }, include: { seo: true } }))
      .seo;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    const created = await prisma?.legacy436Backfill.findMany({
      where: { kind: { in: ['tag', 'category'] }, created: true },
    });
    await prisma?.tag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma?.category.deleteMany({ where: { id: { in: categoryIds } } });
    if (pageId) await prisma?.page.deleteMany({ where: { id: pageId } });
    await prisma?.seo.deleteMany({
      where: { id: { in: [...seoIds, ...(created ?? []).map((b) => b.seoId)] } },
    });
    await moduleRef?.close();
  });

  it('заполняет пустые Seo.X, не трогает заполненные и чужие, переживает повтор и откатывается рецептом', async () => {
    const tag = await prisma.tag.create({
      data: { name: 'L436', slug: `l436-mig-${stamp}`, key: `l436-mig-${stamp}` },
    });
    tagIds.push(tag.id);
    const category = await prisma.category.create({
      data: {
        name: 'L436',
        slug: `l436-mig-cat-${stamp}`,
        key: `l436-mig-cat-${stamp}`,
        type: 'category',
      },
    });
    categoryIds.push(category.id);

    // 1. Перевод без `Seo`, meta только в плоских колонках — как писал импорт.
    const noSeo = await prisma.tagTranslation.create({
      data: {
        tagId: tag.id,
        language: Language.en,
        name: 'n',
        slug: `l436-mig-en-${stamp}`,
        metaTitle: 'Flat title',
        ogImageUrl: 'https://cdn.example.com/og.png',
        ogTitle: '   ',
      },
    });

    // 2. `Seo` есть: пустой metaTitle (пробелы) заполняется, заполненный ogTitle остаётся.
    const partialSeo = await prisma.seo.create({
      data: { metaTitle: '  ', ogTitle: 'Seo og', robots: 'noindex' },
    });
    seoIds.push(partialSeo.id);
    const partial = await prisma.categoryTranslation.create({
      data: {
        categoryId: category.id,
        language: Language.en,
        name: 'p',
        slug: `l436-mig-cat-en-${stamp}`,
        metaTitle: 'Flat cat title',
        ogTitle: 'Flat og loses',
        seoId: partialSeo.id,
      },
    });

    // 3. `Seo` делит строку со страницей — не трогается.
    const sharedSeo = await prisma.seo.create({ data: {} });
    seoIds.push(sharedSeo.id);
    const page = await prisma.page.create({
      data: {
        slug: `l436-mig-page-${stamp}`,
        title: 'p',
        type: 'generic',
        content: 'c',
        language: Language.en,
        seoId: sharedSeo.id,
      },
    });
    pageId = page.id;
    const shared = await prisma.tagTranslation.create({
      data: {
        tagId: tag.id,
        language: Language.ru,
        name: 's',
        slug: `l436-mig-ru-${stamp}`,
        metaTitle: 'Must not reach page',
        seoId: sharedSeo.id,
      },
    });

    // 4. Плоские пусты — `Seo` не заводится.
    const empty = await prisma.categoryTranslation.create({
      data: {
        categoryId: category.id,
        language: Language.ru,
        name: 'e',
        slug: `l436-mig-cat-ru-${stamp}`,
      },
    });

    await run();

    const created = await seoOfTag(noSeo.id);
    expect(created).toMatchObject({
      metaTitle: 'Flat title',
      ogImageUrl: 'https://cdn.example.com/og.png',
      ogTitle: null,
    });
    expect(await seoOfCategory(partial.id)).toMatchObject({
      id: partialSeo.id,
      metaTitle: 'Flat cat title',
      ogTitle: 'Seo og',
      robots: 'noindex',
    });
    expect(await seoOfTag(shared.id)).toMatchObject({ id: sharedSeo.id, metaTitle: null });
    expect(
      (await prisma.categoryTranslation.findUniqueOrThrow({ where: { id: empty.id } })).seoId,
    ).toBeNull();

    // Журнал: строка на каждый тронутый перевод, прежние значения — для отката.
    const journal = await prisma.legacy436Backfill.findMany({
      where: { translationId: { in: [noSeo.id, partial.id, shared.id, empty.id] } },
      orderBy: { kind: 'asc' },
    });
    expect(journal).toEqual([
      expect.objectContaining({
        kind: 'category',
        translationId: partial.id,
        seoId: partialSeo.id,
        created: false,
        old: expect.objectContaining({ metaTitle: '  ', ogTitle: 'Seo og' }) as unknown,
      }),
      expect.objectContaining({
        kind: 'tag',
        translationId: noSeo.id,
        seoId: created?.id,
        created: true,
        old: null,
      }),
    ]);

    // Повтор ничего не меняет и не заводит второй строки: ни новой записи журнала, ни новой `Seo`.
    await run();
    expect(
      await prisma.legacy436Backfill.count({
        where: { translationId: { in: [noSeo.id, partial.id, shared.id, empty.id] } },
      }),
    ).toBe(2);
    expect((await seoOfTag(noSeo.id))?.id).toBe(created?.id);
    expect(await seoOfCategory(partial.id)).toMatchObject({ metaTitle: 'Flat cat title' });

    // Рецепт отката возвращает прежнее.
    for (const sql of rollback()) await prisma.$executeRawUnsafe(sql);
    expect(
      (await prisma.tagTranslation.findUniqueOrThrow({ where: { id: noSeo.id } })).seoId,
    ).toBeNull();
    expect(await prisma.seo.findUnique({ where: { id: created!.id } })).toBeNull();
    expect(await seoOfCategory(partial.id)).toMatchObject({ metaTitle: '  ', ogTitle: 'Seo og' });
  });
});
