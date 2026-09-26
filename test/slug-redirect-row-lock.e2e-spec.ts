import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Language, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookService } from '../src/modules/book/book.service';
import { CategoryService } from '../src/modules/category/category.service';
import { SlugRedirectService } from '../src/modules/slug-redirect/slug-redirect.service';
import { PagesService } from '../src/modules/pages/pages.service';
import { BookVersionService } from '../src/modules/book-version/book-version.service';
import { AuthorService } from '../src/modules/author/author.service';
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
  let pages: PagesService;
  let versions: BookVersionService;
  let authors: AuthorService;

  const stamp = Date.now();
  const authorIds: string[] = [];
  const prefix = `rowlock-${stamp}`;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    books = moduleRef.get(BookService);
    categories = moduleRef.get(CategoryService);
    slugRedirects = moduleRef.get(SlugRedirectService);
    pages = moduleRef.get(PagesService);
    versions = moduleRef.get(BookVersionService);
    authors = moduleRef.get(AuthorService);
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      await prisma?.slugRedirect.deleteMany({ where: { oldSlug: { startsWith: prefix } } });
      await prisma?.page.deleteMany({ where: { slug: { startsWith: prefix } } });
      await prisma?.authorTranslation.deleteMany({ where: { slug: { startsWith: prefix } } });
      await prisma?.author.deleteMany({
        where: { translations: { none: {} }, id: { in: authorIds } },
      });
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
  const raceAgainstHeldRename = (
    table: 'Book' | 'Category',
    id: string,
    midSlug: string,
    write: () => Promise<unknown>,
  ) =>
    raceAgainstHeld(
      async (tx) => {
        if (table === 'Book') {
          await tx.$executeRaw`UPDATE "Book" SET slug = ${midSlug} WHERE id = ${id}`;
        } else {
          await tx.$executeRaw`UPDATE "Category" SET slug = ${midSlug} WHERE id = ${id}`;
        }
      },
      table,
      write,
    );

  /**
   * То же для любой строки: `hold` меняет слаг сырым SQL и держит строку, `table` —
   * таблица, на которой второй писатель встаёт в ожидание (по тексту его запроса).
   */
  const raceAgainstHeld = async (
    hold: (tx: Prisma.TransactionClient) => Promise<void>,
    table: string | string[],
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
        await hold(tx);
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
  const waitUntilWriterWaitsOnLock = async (table: string | string[]) => {
    const patterns = (Array.isArray(table) ? table : [table]).map((name) => `%"${name}"%`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE ANY (${patterns})`;
      if (waiting > 0) return;
      await sleep(50);
    }
    throw new Error('второй писатель так и не встал на замок строки');
  };

  const redirectsFrom = (entityType: 'book' | 'category' | 'page' | 'author', oldSlug: string) =>
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
   * 🔴 `LEGACY-320`, остаток (пачка `T54`). Те же гонки у писателей редиректа слага
   * перевода категории, страницы и версии книги: старый слаг брался из снимка
   * без замка строки.
   */
  it('перевод категории: вторая смена слага пишет редирект с промежуточного слага', async () => {
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Tr lock ${stamp}`,
        slug: `${prefix}-trcat`,
        key: `${prefix}-trcat`,
        translations: {
          create: { language: Language.en, name: 'Tr', slug: `${prefix}-tr-a` },
        },
      },
      include: { translations: true },
    });
    const trId = category.translations[0].id;

    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "CategoryTranslation" SET slug = ${`${prefix}-tr-b`} WHERE id = ${trId}`;
      },
      'CategoryTranslation',
      () => categories.updateTranslation(category.id, Language.en, { slug: `${prefix}-tr-c` }),
    );

    // 🔴 До правки слаг брался из чтения на пуле (`-tr-a`), и `-tr-b` оставался без редиректа.
    expect(await redirectsFrom('category', `${prefix}-tr-b`)).toEqual([
      { newSlug: `${prefix}-tr-c` },
    ]);
  }, 120_000);

  /**
   * 🔴 `LEGACY-320`, остаток пачки `T55`. `deleteTranslation` и `remove()` уже читали
   * снимок ТЕМ ЖЕ `tx`, что и писали (`T54` закрыл гонку у `updateTranslation`), но
   * без `FOR NO KEY UPDATE`: замок дерева — advisory, не замок строки, и от него
   * `updateTranslation` сознательно освобождён (комментарий над её вызовом
   * `runInTree`-исключения). Плоское чтение не вставало в очередь за строкой,
   * которую держит встречный `updateTranslation`, и адрес редиректа брался устаревшим.
   */
  it('перевод категории: удаление перевода пишет редирект со слага, встроенного встречной правкой', async () => {
    const parent = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Del parent ${stamp}`,
        slug: `${prefix}-delparent`,
        key: `${prefix}-delparent`,
        translations: {
          create: { language: Language.en, name: 'Parent', slug: `${prefix}-delparent-tr` },
        },
      },
    });
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Del tr ${stamp}`,
        slug: `${prefix}-deltrcat`,
        key: `${prefix}-deltrcat`,
        parentId: parent.id,
        translations: {
          create: { language: Language.en, name: 'Tr', slug: `${prefix}-deltr-a` },
        },
      },
      include: { translations: true },
    });
    const trId = category.translations[0].id;

    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "CategoryTranslation" SET slug = ${`${prefix}-deltr-b`} WHERE id = ${trId}`;
      },
      'CategoryTranslation',
      () => categories.deleteTranslation(category.id, Language.en, 'e2e-actor'),
    );

    // 🔴 До правки слаг брался из чтения без замка (`-deltr-a`), и `-deltr-b` — живой
    // на момент удаления адрес — оставался без редиректа на родителя.
    expect(await redirectsFrom('category', `${prefix}-deltr-b`)).toEqual([
      { newSlug: `${prefix}-delparent-tr` },
    ]);
  }, 120_000);

  it('категория: удаление термина пишет редирект переводов со слага, встроенного встречной правкой', async () => {
    const parent = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Remove parent ${stamp}`,
        slug: `${prefix}-remparent`,
        key: `${prefix}-remparent`,
        translations: {
          create: { language: Language.en, name: 'Parent', slug: `${prefix}-remparent-tr` },
        },
      },
    });
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Remove tr ${stamp}`,
        slug: `${prefix}-remcat`,
        key: `${prefix}-remcat`,
        parentId: parent.id,
        translations: {
          create: { language: Language.en, name: 'Tr', slug: `${prefix}-remtr-a` },
        },
      },
      include: { translations: true },
    });
    const trId = category.translations[0].id;

    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "CategoryTranslation" SET slug = ${`${prefix}-remtr-b`} WHERE id = ${trId}`;
      },
      'CategoryTranslation',
      () => categories.remove(category.id, 'e2e-actor'),
    );

    // 🔴 До правки `dying` читался `findMany` без замка (`-remtr-a`), и `-remtr-b`
    // оставался без редиректа при удалении всего термина.
    expect(await redirectsFrom('category', `${prefix}-remtr-b`)).toEqual([
      { newSlug: `${prefix}-remparent-tr` },
    ]);
  }, 120_000);

  it('страница: вторая смена слага пишет редирект с промежуточного слага', async () => {
    const page = await prisma.page.create({
      data: {
        slug: `${prefix}-page-a`,
        title: 'Row lock',
        type: 'generic',
        content: 'c',
        language: Language.en,
      },
    });

    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "Page" SET slug = ${`${prefix}-page-b`} WHERE id = ${page.id}`;
      },
      'Page',
      () => pages.update(page.id, { slug: `${prefix}-page-c` }, 'e2e-actor'),
    );

    expect(await redirectsFrom('page', `${prefix}-page-b`)).toEqual([
      { newSlug: `${prefix}-page-c` },
    ]);
  }, 120_000);

  /**
   * 🔴 `LEGACY-400`, пачка `T55`. Проверка дубля в `update` не видит незакоммиченную чужую
   * вставку той же пары `(language, slug)`: рубеж — уникальный индекс, и его `P2002` под
   * `@prisma/adapter-pg` приходит без `meta.target`. Встречная транзакция держит переименование
   * страницы B в слаг X, `update(A, {slug: X})` ждёт на индексе и после коммита держателя
   * обязан ответить 400, а не 500.
   */
  it('страница: гонка двух переименований в один слаг — 400, а не 500', async () => {
    const pageA = await prisma.page.create({
      data: {
        slug: `${prefix}-dupA`,
        title: 'A',
        type: 'generic',
        content: 'c',
        language: Language.en,
      },
    });
    const pageB = await prisma.page.create({
      data: {
        slug: `${prefix}-dupB`,
        title: 'B',
        type: 'generic',
        content: 'c',
        language: Language.en,
      },
    });
    const taken = `${prefix}-dupX`;

    let outcome: unknown = null;
    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "Page" SET slug = ${taken} WHERE id = ${pageB.id}`;
      },
      'Page',
      () =>
        pages.update(pageA.id, { slug: taken }, 'e2e-actor').then(
          () => (outcome = 'updated'),
          (error: unknown) => (outcome = error),
        ),
    );

    expect(outcome).toBeInstanceOf(BadRequestException);
  }, 120_000);

  it('версия книги: вторая смена слага пишет редирект с промежуточного слага', async () => {
    const book = await createBookFixture(prisma, `${prefix}-vbook`);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.en,
        slug: `${prefix}-ver-a`,
        title: 'Row lock',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });

    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "BookVersion" SET slug = ${`${prefix}-ver-b`} WHERE id = ${version.id}`;
      },
      'BookVersion',
      () => versions.update(version.id, { slug: `${prefix}-ver-c` }),
    );

    expect(await redirectsFrom('book', `${prefix}-ver-b`)).toEqual([
      { newSlug: `${prefix}-ver-c` },
    ]);
  }, 120_000);

  /**
   * У автора слаг живёт только в переводах, которые правка удаляет и создаёт заново,
   * поэтому запирается строка `Author`. Встречный писатель держит её так же, как
   * держала бы вторая правка того же автора. Ожидание засчитывается и на переводах:
   * без правки второй писатель встаёт не на `Author`, а на удалении переводов —
   * уже после чтения устаревшего слага.
   */
  it('автор: встречная правка того же автора ждёт замка, редирект — с промежуточного слага', async () => {
    const author = await prisma.author.create({
      data: {
        translations: {
          create: { language: Language.en, name: 'Row lock', slug: `${prefix}-auth-a` },
        },
      },
    });
    authorIds.push(author.id);

    await raceAgainstHeld(
      async (tx) => {
        await tx.$executeRaw`UPDATE "Author" SET "updatedAt" = now() WHERE id = ${author.id}`;
        await tx.$executeRaw`UPDATE "AuthorTranslation" SET slug = ${`${prefix}-auth-b`} WHERE "authorId" = ${author.id}`;
      },
      ['Author', 'AuthorTranslation'],
      () =>
        authors.update(author.id, {
          translations: [{ language: Language.en, name: 'Row lock', slug: `${prefix}-auth-c` }],
        }),
    );

    expect(await redirectsFrom('author', `${prefix}-auth-b`)).toEqual([
      { newSlug: `${prefix}-auth-c` },
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
