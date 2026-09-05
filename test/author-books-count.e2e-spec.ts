import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';
import { createBookFixture } from './helpers/book-fixture';

/**
 * `tasks/authors-indexability/TASK.md` §2.
 *
 * `GET /:lang/authors` отдавал `booksCount: 0` **всем** авторам, включая тех, чьи
 * книги лежат в каталоге: считался `_count.bookVersions`, то есть строки по
 * внешнему ключу `BookVersion.authorId`, а он в проде NULL у всех опубликованных
 * версий. Настоящая связь держится на строковом поле `BookVersion.author`.
 *
 * 🔴 Цена ошибки здесь не косметическая: этот счётчик — вход для `noindex` и для
 * фильтра sitemap. Нулём «по недосчёту» он закрыл бы от индексации все страницы
 * авторов разом.
 */
describe('Authors: books count (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  const prefix = `author-count-${stamp}`;

  // Автор с книгой, связанной **только строкой** — ровно как в проде.
  const withBookEn = `With Book EN ${stamp}`;
  const withBookRu = `Со Книгой RU ${stamp}`;
  let withBookId = '';
  // Автор без единой книги — контрольный: он и должен остаться нулём.
  let emptyId = '';
  let bookId = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    await app.init();

    const author = await prisma.author.create({
      data: {
        translations: {
          create: [
            { language: Language.en, slug: `${prefix}-with-en`, name: withBookEn },
            { language: Language.ru, slug: `${prefix}-with-ru`, name: withBookRu },
          ],
        },
      },
    });
    withBookId = author.id;

    const empty = await prisma.author.create({
      data: {
        translations: {
          create: [{ language: Language.en, slug: `${prefix}-empty-en`, name: `Empty ${stamp}` }],
        },
      },
    });
    emptyId = empty.id;

    const book = await createBookFixture(prisma, `${prefix}-book`);
    bookId = book.id;

    const version = {
      bookId: book.id,
      description: 'd',
      coverImageUrl: 'https://example.com/c.png',
      type: 'text' as const,
      isFree: true,
    };

    await prisma.bookVersion.createMany({
      data: [
        // authorId намеренно НЕ проставлен — воспроизводим прод.
        {
          ...version,
          language: Language.en,
          title: `T en ${stamp}`,
          author: withBookEn,
          status: 'published',
        },
        {
          ...version,
          language: Language.ru,
          title: `T ru ${stamp}`,
          author: withBookRu,
          status: 'published',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.bookVersion.deleteMany({ where: { bookId } });
    await prisma.book.deleteMany({ where: { id: bookId } });
    await prisma.author.deleteMany({ where: { id: { in: [withBookId, emptyId] } } });
    await app.close();
  });

  /**
   * Столько строк просит спека, чтобы увидеть всех авторов тестовой базы разом.
   *
   * ⚠️ Ровно потолок ручки (`PUBLIC_AUTHORS_MAX_LIMIT`), а не «побольше на всякий
   * случай». Раньше здесь стояла тысяча, и это работало лишь потому, что потолка
   * не было вовсе: `?limit=1000` теперь отдаёт 400, `res.body.data` становится
   * `undefined`, и `findAuthor` падает на `.find()`. Авторов в тестовой базе
   * единицы, так что сотни хватает с запасом; перестанет хватать — спека
   * обязана начать листать, а не просить ещё больше.
   */
  const AUTHORS_PAGE_LIMIT = 100;

  type ListedAuthor = { id: string; slug: string; name: string; booksCount: number };
  const findAuthor = (body: unknown, id: string): ListedAuthor | undefined =>
    (body as { data: ListedAuthor[] }).data.find((a) => a.id === id);

  // 🔴 Сам дефект: книга связана строкой, FK пуст — и счётчик обязан её увидеть.
  it('counts a book linked only by the author name string', async () => {
    const res = await request(httpServerOf(app))
      .get('/en/authors')
      .query({ limit: AUTHORS_PAGE_LIMIT });

    expect(findAuthor(res.body, withBookId)?.booksCount).toBe(1);
  });

  // 🔴 Контроль от противоположной ошибки: «считать хоть что-нибудь» — не решение.
  // Автор без книг обязан остаться нулём, иначе noindex не сработает никогда.
  it('leaves an author without books at zero', async () => {
    const res = await request(httpServerOf(app))
      .get('/en/authors')
      .query({ limit: AUTHORS_PAGE_LIMIT });

    expect(findAuthor(res.body, emptyId)?.booksCount).toBe(0);
  });

  // 🔴 Имя автора в русской версии книги записано по-русски. Сверять его с
  // английским переводом бессмысленно — совпадение обязано искаться в своём языке.
  it('matches the name within its own language', async () => {
    const ru = await request(httpServerOf(app))
      .get('/ru/authors')
      .query({ limit: AUTHORS_PAGE_LIMIT });

    expect(findAuthor(ru.body, withBookId)?.booksCount).toBe(1);
    expect(findAuthor(ru.body, withBookId)?.name).toBe(withBookRu);
    expect(findAuthor(ru.body, withBookId)?.slug).toBe(`${prefix}-with-ru`);
  });

  // 🔴 До правки язык пути в сервис не передавался вовсе, и слаг на любом языке
  // приходил английский.
  it('returns the requested language slug, not the English one', async () => {
    const en = await request(httpServerOf(app))
      .get('/en/authors')
      .query({ limit: AUTHORS_PAGE_LIMIT });

    expect(findAuthor(en.body, withBookId)?.slug).toBe(`${prefix}-with-en`);
  });

  /**
   * 🔴 Автор без перевода на язык списка не имеет на нём страницы вовсе: ссылка
   * вела бы в 404, потому что soft-404 закрыт 05.08.2026.
   */
  it('hides an author that has no translation into the requested language', async () => {
    const ru = await request(httpServerOf(app))
      .get('/ru/authors')
      .query({ limit: AUTHORS_PAGE_LIMIT });

    expect(findAuthor(ru.body, emptyId)).toBeUndefined();
    expect(findAuthor(ru.body, withBookId)).toBeDefined();
  });

  /**
   * 🔴 Счётчик для языка обязан считать книги **этого** языка.
   *
   * Ловушка тонкая: имя автора локализуют не всегда, и вторая книга вполне может
   * иметь только русскую версию, в которой автор записан по-английски. Без
   * сверки `bv.language = t.language` такая версия попадёт в английский счётчик —
   * и англоязычная страница автора заявит книгу, которой на ней нет.
   *
   * Первая редакция этого набора дефект не ловила: обе версии принадлежали одной
   * книге, а считаются различные книги, так что подмена языка ничего не меняла.
   * Мутация «убрать сверку языка» проходила зелёной.
   */
  it('does not count a version from another language', async () => {
    const otherBook = await createBookFixture(prisma, `${prefix}-ru-only-book`);
    await prisma.bookVersion.create({
      data: {
        bookId: otherBook.id,
        language: Language.ru,
        title: `RU only ${stamp}`,
        // Имя оставлено английским — версия русская, автор подписан как в оригинале.
        author: withBookEn,
        description: 'd',
        coverImageUrl: 'https://example.com/c.png',
        type: 'text',
        isFree: true,
        status: 'published',
      },
    });

    try {
      const en = await request(httpServerOf(app))
        .get('/en/authors')
        .query({ limit: AUTHORS_PAGE_LIMIT });
      expect(findAuthor(en.body, withBookId)?.booksCount).toBe(1);
    } finally {
      await prisma.bookVersion.deleteMany({ where: { bookId: otherBook.id } });
      await prisma.book.delete({ where: { id: otherBook.id } });
    }
  });

  // Черновик — не опубликованная книга, и в счётчик попадать не должен.
  it('ignores a draft version', async () => {
    await prisma.bookVersion.updateMany({
      where: { bookId, language: Language.en },
      data: { status: 'draft' },
    });

    const res = await request(httpServerOf(app))
      .get('/en/authors')
      .query({ limit: AUTHORS_PAGE_LIMIT });
    expect(findAuthor(res.body, withBookId)?.booksCount).toBe(0);

    await prisma.bookVersion.updateMany({
      where: { bookId, language: Language.en },
      data: { status: 'published' },
    });
  });
});
