import { Test, TestingModule } from '@nestjs/testing';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookService } from '../src/modules/book/book.service';
import { CategoryService } from '../src/modules/category/category.service';
import { SlugRedirectService } from '../src/modules/slug-redirect/slug-redirect.service';
import { createBookFixture } from './helpers/book-fixture';

/**
 * 🔴 `LEGACY-320`, пачка `T32`. Редирект со старого базового слага писался по снимку
 * без замка строки: `BookService.update` читал книгу на пуле, `CategoryService.update`
 * читал термин в транзакции, но без `FOR UPDATE`. Встречная смена слага, закоммиченная
 * между чтением и записью, оставалась без редиректа со своего слага: он жил, мог попасть
 * в индекс и после второй правки отдавал 404.
 *
 * ⚠️ Встречная правка держит строку сырой транзакцией, а не вторым вызовом сервиса:
 * два одновременных вызова дают недетерминированный порядок, а здесь нужен ровно один —
 * первая смена слага ещё не закоммичена, когда вторая начинает читать.
 *
 * HTTP-слой не поднимается — по той же причине, что в `tag-row-lock.e2e-spec.ts`.
 */
describe('LEGACY-320 — редирект базового слага пишется под замком строки (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let books: BookService;
  let categories: CategoryService;
  let slugRedirects: SlugRedirectService;

  const stamp = Date.now();
  const prefix = `rowlock-${stamp}`;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    books = moduleRef.get(BookService);
    categories = moduleRef.get(CategoryService);
    slugRedirects = moduleRef.get(SlugRedirectService);
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      await prisma?.slugRedirect.deleteMany({ where: { oldSlug: { startsWith: prefix } } });
      await prisma?.book.deleteMany({ where: { slug: { startsWith: prefix } } });
      await prisma?.category.deleteMany({
        where: { key: { startsWith: prefix }, parentId: { not: null } },
      });
      await prisma?.category.deleteMany({ where: { key: { startsWith: prefix } } });
    } finally {
      await moduleRef?.close();
    }
  });

  /**
   * Сырая транзакция меняет слаг `table` на `midSlug` и держит строку до `release`.
   * Пока она открыта, запускается `write`; после коммита держателя `write` обязан
   * увидеть `midSlug`, а не слаг до него.
   */
  const raceAgainstHeldRename = async (
    table: 'Book' | 'Category',
    id: string,
    midSlug: string,
    write: () => Promise<unknown>,
  ) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        if (table === 'Book') {
          await tx.$executeRaw`UPDATE "Book" SET slug = ${midSlug} WHERE id = ${id}`;
        } else {
          await tx.$executeRaw`UPDATE "Category" SET slug = ${midSlug} WHERE id = ${id}`;
        }
        locked();
        await gate;
      },
      { timeout: 60_000 },
    );

    await holding;
    // Отказ `write` ловится сразу, а не через секунды: иначе он висит необработанным,
    // а при отказе держателя теряется вовсе.
    const second = write().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    try {
      await waitUntilWriterWaitsOnLock(table);
    } finally {
      release();
    }
    await holder;
    const failure = await second;
    if (failure) throw failure;
  };

  /**
   * ⚠️ Не `sleep`: на медленном прогоне `write` мог бы не дойти до чтения слага к моменту
   * коммита держателя и прочитать уже новый слаг — посадка позеленела бы и без правки.
   * Здесь держатель отпускает строку, только когда второй писатель уже стоит на замке:
   * с правкой — на `FOR NO KEY UPDATE` до чтения, без правки — на записи после устаревшего
   * чтения. Ожидание отбирается по таблице в тексте запроса: соседний набор, стоящий
   * на своём замке, иначе отпустил бы держателя раньше времени.
   */
  const waitUntilWriterWaitsOnLock = async (table: 'Book' | 'Category') => {
    const pattern = `%"${table}"%`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE ${pattern}`;
      if (waiting > 0) return;
      await sleep(50);
    }
    throw new Error('второй писатель так и не встал на замок строки');
  };

  const redirectsFrom = (entityType: 'book' | 'category', oldSlug: string) =>
    prisma.slugRedirect.findMany({
      where: { entityType, oldSlug, language: Language.en },
      select: { newSlug: true },
    });

  it('книга: вторая смена слага пишет редирект с промежуточного слага, а не с исходного', async () => {
    const book = await createBookFixture(prisma, `${prefix}-book-a`);

    await raceAgainstHeldRename('Book', book.id, `${prefix}-book-b`, () =>
      books.update(book.id, { slug: `${prefix}-book-c` }),
    );

    const after = await prisma.book.findUnique({ where: { id: book.id } });
    expect(after?.slug).toBe(`${prefix}-book-c`);
    // 🔴 Суть проверки. До правки `update` брал старый слаг из чтения на пуле
    // (`-book-a`), и `-book-b` оставался без редиректа — 404 после второй правки.
    expect(await redirectsFrom('book', `${prefix}-book-b`)).toEqual([
      { newSlug: `${prefix}-book-c` },
    ]);
  }, 120_000);

  it('категория: вторая смена слага пишет редирект с промежуточного слага, а не с исходного', async () => {
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Row lock ${stamp}`,
        slug: `${prefix}-cat-a`,
        key: `${prefix}-cat`,
      },
    });

    await raceAgainstHeldRename('Category', category.id, `${prefix}-cat-b`, () =>
      categories.update(category.id, { slug: `${prefix}-cat-c` }),
    );

    const after = await prisma.category.findUnique({ where: { id: category.id } });
    expect(after?.slug).toBe(`${prefix}-cat-c`);
    // 🔴 До правки термин перечитывался в транзакции без `FOR UPDATE`: на `read
    // committed` незакоммиченная смена не видна, редирект уходил с `-cat-a`.
    expect(await redirectsFrom('category', `${prefix}-cat-b`)).toEqual([
      { newSlug: `${prefix}-cat-c` },
    ]);
  }, 120_000);

  /**
   * 🔴 Обратная сторона замка (решение арбитра 25.09.2026). `FOR UPDATE` конфликтует
   * с `FOR KEY SHARE`, который берёт проверка внешнего ключа, и вставки со ссылкой
   * на книгу или термин ждали бы всю транзакцию PATCH — до правки такого ожидания
   * не было. `FOR NO KEY UPDATE` их пропускает. Транзакция PATCH держится открытой
   * на записи редиректа, то есть уже после замка строки и до записи слага.
   */
  const insertWhilePatchHoldsRow = async (
    patch: () => Promise<unknown>,
    insert: () => Promise<unknown>,
  ) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = jest.spyOn(slugRedirects, 'recordBaseSlugChange').mockImplementation(async () => {
      entered();
      await gate;
    });

    const patching = patch().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    try {
      await inside;
      const timedOut = Symbol('timed out');
      const outcome = await Promise.race([
        insert().then(() => 'inserted'),
        sleep(5000).then(() => timedOut),
      ]);
      expect(outcome).toBe('inserted');
    } finally {
      release();
      spy.mockRestore();
    }
    const failure = await patching;
    if (failure) throw failure;
  };

  it('книга: вставка версии не ждёт открытой транзакции PATCH', async () => {
    const book = await createBookFixture(prisma, `${prefix}-fk-book`);

    await insertWhilePatchHoldsRow(
      () => books.update(book.id, { slug: `${prefix}-fk-book-new` }),
      () =>
        prisma.bookVersion.create({
          data: {
            bookId: book.id,
            language: 'en',
            title: `${prefix} version`,
            author: 'A',
            description: 'D',
            coverImageUrl: 'https://example.com/c.jpg',
            type: 'text',
            isFree: true,
          },
        }),
    );
  }, 120_000);

  it('категория: вставка дочернего термина не ждёт открытой транзакции PATCH', async () => {
    const parent = await prisma.category.create({
      data: {
        type: 'genre',
        name: `FK parent ${stamp}`,
        slug: `${prefix}-fk-parent`,
        key: `${prefix}-fk-parent`,
      },
    });

    await insertWhilePatchHoldsRow(
      () => categories.update(parent.id, { slug: `${prefix}-fk-parent-new` }),
      () =>
        prisma.category.create({
          data: {
            type: 'genre',
            name: `FK child ${stamp}`,
            slug: `${prefix}-fk-child`,
            key: `${prefix}-fk-child`,
            parentId: parent.id,
          },
        }),
    );
  }, 120_000);
});
