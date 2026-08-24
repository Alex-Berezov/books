import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

/**
 * Хаб авторов через настоящий HTTP-слой и настоящий Postgres.
 *
 * 🔴 Юнит-спеки `listPublic` и `listPublicLetters` проверяют **текст** сырого SQL
 * против мока `$queryRaw` — они не выполняют его ни разу. Опечатка в `GROUP BY`,
 * в аргументах `translate()`/`btrim()` или в `<> ALL (...)` даёт 500 на проде при
 * полностью зелёном `yarn test`. Здесь запросы действительно исполняются.
 *
 * Ровно так же не проверялась и валидация: `@Max`, `@Type(() => Number)`, регулярка
 * буквы и самописный разбор `hasBooks` живут в `ValidationPipe`, а юнит-тесты зовут
 * контроллер напрямую, минуя его.
 */
describe('Authors hub (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  const prefix = `authors-hub-${stamp}`;

  // Имена подобраны под краевые случаи указателя: своя буква, диакритика,
  // не-буква и автор без книг.
  const dostoevsky = `Достоевский ${stamp}`;
  const edouard = `Édouard ${stamp}`;
  const numeric = `50 Cent ${stamp}`;
  const emptyRu = `Достоевна Пустая ${stamp}`;

  let withBookId = '';
  // Две книги, а не две версии одной: `@@unique([bookId, language])` не даёт
  // положить текстовую и аудио версии одного языка в одну книгу.
  let textBookId = '';
  let audioBookId = '';

  const get = (path: string) => request(httpServerOf(app)).get(path);

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

    const withBook = await prisma.author.create({
      data: {
        birthDate: '1821-11-11',
        deathDate: '1881-02-09',
        translations: {
          create: [
            {
              language: Language.ru,
              slug: `${prefix}-dostoevsky-ru`,
              name: dostoevsky,
              biography: `<p>Русский <b>писатель</b>.</p> ${'слово '.repeat(200)}`,
            },
            { language: Language.en, slug: `${prefix}-dostoevsky-en`, name: `Dostoevsky ${stamp}` },
          ],
        },
      },
    });
    withBookId = withBook.id;

    await prisma.author.create({
      data: {
        translations: {
          create: [{ language: Language.ru, slug: `${prefix}-empty-ru`, name: emptyRu }],
        },
      },
    });

    await prisma.author.create({
      data: {
        translations: {
          create: [{ language: Language.fr, slug: `${prefix}-edouard-fr`, name: edouard }],
        },
      },
    });

    await prisma.author.create({
      data: {
        translations: {
          create: [{ language: Language.en, slug: `${prefix}-numeric-en`, name: numeric }],
        },
      },
    });

    // Связь только строкой — ровно как в проде, где FK у опубликованных версий NULL.
    const textBook = await prisma.book.create({ data: { slug: `${prefix}-text` } });
    textBookId = textBook.id;
    const audioBook = await prisma.book.create({ data: { slug: `${prefix}-audio` } });
    audioBookId = audioBook.id;

    const version = {
      language: Language.ru,
      author: dostoevsky,
      description: 'd',
      coverImageUrl: 'https://example.com/c.png',
      isFree: true,
      status: 'published' as const,
    };

    await prisma.bookVersion.create({
      data: { ...version, bookId: textBookId, title: `Идиот ${stamp}`, type: 'text' },
    });
    await prisma.bookVersion.create({
      data: { ...version, bookId: audioBookId, title: `Бесы аудио ${stamp}`, type: 'audio' },
    });
  });

  afterAll(async () => {
    await prisma.bookVersion.deleteMany({ where: { bookId: { in: [textBookId, audioBookId] } } });
    await prisma.book.deleteMany({ where: { id: { in: [textBookId, audioBookId] } } });
    await prisma.authorTranslation.deleteMany({ where: { slug: { startsWith: prefix } } });
    await prisma.author.deleteMany({ where: { translations: { none: {} } } });
    await app.close();
  });

  type Card = {
    id: string;
    slug: string;
    name: string;
    shortBio: string | null;
    booksCount: number;
    audioCount: number;
    translations: Array<{ language: string; slug: string; name: string }>;
  };

  interface ListResponse {
    data: Card[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }

  type LettersResponse = Array<{ letter: string; count: number }>;

  // `res.body` у supertest — `any`, и линт справедливо ругается на доступ к нему.
  // Приводим один раз здесь, а не рассыпаем касты по тесту.
  const list = (res: request.Response): ListResponse => res.body as ListResponse;
  const letters = (res: request.Response): LettersResponse => res.body as LettersResponse;

  const find = (res: request.Response, id: string) => list(res).data.find((a) => a.id === id);

  it('serves the list and counts books and audiobooks of the path language', async () => {
    const res = await get('/ru/authors?limit=100').expect(200);
    const card = find(res, withBookId);

    // Две книги, одна из них аудио: `booksCount` считает различные книги,
    // `audioCount` — те из них, у которых версия этого языка `type = 'audio'`.
    expect(card?.booksCount).toBe(2);
    expect(card?.audioCount).toBe(1);
  });

  // 🔴 LEGACY-214: анонимной ручке незачем биография, quotes, faq и Seo.
  it('never puts the editorial fields on the wire', async () => {
    const res = await get('/ru/authors?limit=100').expect(200);
    const card = find(res, withBookId);

    expect(Object.keys(card!).sort()).toEqual([
      'audioCount',
      'birthDate',
      'booksCount',
      'deathDate',
      'id',
      'name',
      'photoUrl',
      'shortBio',
      'slug',
      'translations',
    ]);
    expect(card!.shortBio!.endsWith('…')).toBe(true);
    expect([...card!.shortBio!].length).toBeLessThanOrEqual(161);
    card!.translations.forEach((t) =>
      expect(Object.keys(t).sort()).toEqual(['language', 'name', 'slug']),
    );
  });

  it('filters by letter through the folded first letter', async () => {
    const res = await get('/ru/authors?letter=Д&limit=100').expect(200);

    expect(find(res, withBookId)).toBeDefined();
    expect(list(res).data.every((a: Card) => a.name.toUpperCase().startsWith('Д'))).toBe(true);
  });

  // Диакритика сворачивается в базовую букву: `Édouard` живёт под `E`, не под `#`.
  it('folds diacritics into the base letter', async () => {
    const res = await get('/fr/authors?letter=E&limit=100').expect(200);

    expect(list(res).data.some((a: Card) => a.name === edouard)).toBe(true);
  });

  it('puts names that start with neither letter into the # group', async () => {
    const res = await get('/en/authors?letter=%23&limit=100').expect(200);

    expect(list(res).data.some((a: Card) => a.name === numeric)).toBe(true);
  });

  // 🔴 `?letter=W` на `/ru/` сводился к литералу `'#'` и отдавал 200 с пустым
  // списком, который ещё и оседал в общем кэше на пять минут.
  it('rejects a letter outside the alphabet of the path language', async () => {
    await get('/ru/authors?letter=W').expect(400);
    await get('/en/authors?letter=Д').expect(400);
    await get('/ru/authors?letter=abc').expect(400);
  });

  it('drops authors without books only when asked', async () => {
    const withoutFilter = await get('/ru/authors?limit=100').expect(200);
    expect(list(withoutFilter).data.some((a: Card) => a.name === emptyRu)).toBe(true);

    const filtered = await get('/ru/authors?limit=100&hasBooks=true').expect(200);
    expect(list(filtered).data.some((a: Card) => a.name === emptyRu)).toBe(false);
    expect(find(filtered, withBookId)).toBeDefined();
  });

  // `?hasBooks=1` и `?hasBooks=yes` раньше молча давали `false`.
  it('understands the usual spellings of a boolean and rejects the rest', async () => {
    for (const value of ['true', '1', 'yes']) {
      const res = await get(`/ru/authors?limit=100&hasBooks=${value}`).expect(200);
      expect(list(res).data.some((a: Card) => a.name === emptyRu)).toBe(false);
    }
    for (const value of ['false', '0', 'no']) {
      const res = await get(`/ru/authors?limit=100&hasBooks=${value}`).expect(200);
      expect(list(res).data.some((a: Card) => a.name === emptyRu)).toBe(true);
    }
    await get('/ru/authors?hasBooks=maybe').expect(400);
  });

  it('searches by name case-insensitively', async () => {
    const res = await get(`/ru/authors?search=${encodeURIComponent('достоевск')}&limit=100`).expect(
      200,
    );

    expect(find(res, withBookId)).toBeDefined();
  });

  // `%` и `_` — символы запроса, а не подстановки.
  it('escapes LIKE wildcards instead of matching everything', async () => {
    const res = await get('/ru/authors?search=%25&limit=100').expect(200);

    expect(list(res).data).toHaveLength(0);
  });

  it('sorts by book count in the database, not in memory', async () => {
    const res = await get('/ru/authors?sort=books&limit=100').expect(200);

    const counts = list(res).data.map((a: Card) => a.booksCount);
    expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts);
  });

  it('rejects a page size above the cap instead of truncating it', async () => {
    await get('/ru/authors?limit=1000').expect(400);
    await get('/ru/authors?limit=0').expect(400);

    const capped = await get('/ru/authors?limit=100').expect(200);
    expect(list(capped).meta.limit).toBe(100);
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    await get('/ru/authors?nonsense=1').expect(400);
    await get('/ru/authors?sort=oldest').expect(400);
    await get('/ru/authors?page=garbage').expect(400);
  });

  describe('GET /:lang/authors/letters', () => {
    // 🔴 Маршрут объявлен выше `authors/:slug`. Окажись он ниже — Nest съел бы
    // его как поиск автора со слагом `letters` и отдал бы 404.
    it('is reachable and not swallowed by authors/:slug', async () => {
      const res = await get('/ru/authors/letters').expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(letters(res).length).toBeGreaterThan(0);
    });

    it('returns the whole alphabet of the path language with # last', async () => {
      const ru = await get('/ru/authors/letters').expect(200);
      expect(letters(ru)[0].letter).toBe('А');
      expect(letters(ru).at(-1)?.letter).toBe('#');
      expect(letters(ru)).toHaveLength(30);

      const en = await get('/en/authors/letters').expect(200);
      expect(letters(en)[0].letter).toBe('A');
      expect(letters(en)).toHaveLength(27);
    });

    // Счётчик буквы обязан совпасть с числом карточек под ней: указатель
    // показывает только авторов с книгами, и сетка тоже.
    it('counts only authors that have books, matching the grid', async () => {
      const index = await get('/ru/authors/letters').expect(200);
      const cards = await get('/ru/authors?letter=Д&limit=100&hasBooks=true').expect(200);

      const de = letters(index).find((l) => l.letter === 'Д');
      expect(de?.count).toBe(list(cards).meta.total);
    });

    it('narrows the counts by the same search the grid uses', async () => {
      const term = encodeURIComponent('достоевск');
      const index = await get(`/ru/authors/letters?search=${term}`).expect(200);
      const cards = await get(`/ru/authors?search=${term}&limit=100&hasBooks=true`).expect(200);

      const total = letters(index).reduce((sum, l) => sum + l.count, 0);
      expect(total).toBe(list(cards).meta.total);
    });

    it('rejects an unknown query parameter', async () => {
      await get('/ru/authors/letters?letter=Д').expect(400);
    });
  });
});
