import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookType, Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

/**
 * Порядок выдачи `GET /:lang/books/cards` на настоящем Postgres.
 *
 * `LEGACY-253`: второй ключ сортировки был перевёрнут. `comparePublishedAtDesc`
 * звалась с переставленными аргументами, поэтому функция, названная `Desc`,
 * упорядочивала `publishedAt` по возрастанию, а книги без даты ставила в начало
 * группы; при переносе ветки `popular` на SQL это переехало в `ASC NULLS FIRST`.
 * У книг без оценок рейтинг общий, и таких большинство — то есть второй ключ
 * решает порядок почти всей выдачи.
 *
 * `LEGACY-254`: дефолтная ветка брала страницу `findMany` с `distinct: ['bookId']`,
 * а Prisma применяет `distinct` **после** `skip`/`take`. Теперь страница берётся
 * сырым запросом с `DISTINCT ON` до `LIMIT`. Сам дефект на живой базе предъявить
 * нельзя — `@@unique([bookId, language])` не даёт двух версий одной книги на язык,
 * — поэтому устройство запроса стережёт `book.service.query-count.spec.ts`, а здесь
 * проверяется, что переписанный запрос исполняется в Postgres и отдаёт ту же
 * страницу, тот же порядок и тот же `total`, что и прежний.
 *
 * Данные свои и помечены маркером: набор сидов меняется, и посадка не должна
 * от него зависеть.
 */
describe('Book cards: sort order (LEGACY-253, LEGACY-254) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const marker = `ord${Date.now()}`;
  const bookIds: string[] = [];
  let userId = '';

  interface CardRow {
    id: string;
    slug: string;
  }

  interface CardsResponse {
    items: CardRow[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }

  const seedBook = async (suffix: string, publishedAt: Date | null): Promise<string> => {
    const book = await createBookFixture(prisma, `${marker}-${suffix}`);
    await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.ru,
        title: `${marker} ${suffix}`,
        author: `${marker} author`,
        description: 'e2e',
        coverImageUrl: 'https://example.invalid/cover.png',
        type: BookType.text,
        isFree: true,
        status: 'published',
        publishedAt,
        slug: `${marker}-${suffix}`,
      },
    });
    bookIds.push(book.id);
    return book.id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const user = await prisma.user.create({
      data: { email: `${marker}@example.invalid`, languagePreference: Language.ru },
    });
    userId = user.id;

    // Три книги с **одинаковой** оценкой: рейтинг их не различает, весь порядок
    // решает второй ключ. Одна из них без даты публикации вовсе.
    const newer = await seedBook('newer', new Date('2026-01-03T00:00:00Z'));
    const older = await seedBook('older', new Date('2026-01-01T00:00:00Z'));
    const undated = await seedBook('undated', null);

    for (const bookId of [newer, older, undated]) {
      await prisma.bookRating.create({ data: { userId, bookId, score: 4 } });
    }
  });

  afterAll(async () => {
    await prisma.bookRating.deleteMany({ where: { userId } });
    await prisma.bookVersion.deleteMany({ where: { bookId: { in: bookIds } } });
    await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const cards = async (query: string): Promise<CardsResponse> => {
    const res = await request(http()).get(`/ru/books/cards${query}`).expect(200);
    return res.body as CardsResponse;
  };

  it('популярное при равных оценках: сначала самая свежая, книга без даты последней', async () => {
    const res = await cards(`?sort=popular&q=${marker}`);

    expect(res.items.map((item) => item.slug)).toEqual([
      `${marker}-newer`,
      `${marker}-older`,
      `${marker}-undated`,
    ]);
  });

  it('каталог по дате: тот же порядок, что и обещает JSDoc ветки new', async () => {
    const res = await cards(`?q=${marker}`);

    expect(res.items.map((item) => item.slug)).toEqual([
      `${marker}-newer`,
      `${marker}-older`,
      `${marker}-undated`,
    ]);
  });

  /**
   * Переписанный на сырой SQL запрос страницы обязан исполняться в Postgres:
   * ошибка в касте или в `DISTINCT ON` без совпадающего `ORDER BY` даёт 500
   * на публичной витрине при зелёных юнитах.
   */
  it('каталог по дате: страницы не пересекаются, total общий', async () => {
    const first = await cards(`?q=${marker}&limit=2&page=1`);
    const second = await cards(`?q=${marker}&limit=2&page=2`);

    expect(first.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(second.pagination.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);

    const firstIds = first.items.map((item) => item.id);
    expect(second.items.some((item) => firstIds.includes(item.id))).toBe(false);
  });

  /**
   * Условия фильтра живут двумя наборами: `total` дефолтной ветки считает Prisma
   * по объекту `where`, страницу — сырой SQL по своему набору. Фильтр, попавший
   * только в один из них, разведёт список и его же `total` — здесь сверяются оба.
   */
  it('каталог по дате: фильтр по типу одинаково виден и списку, и total', async () => {
    const res = await cards(`?q=${marker}&type=audio`);

    expect(res.pagination.total).toBe(0);
    expect(res.items).toEqual([]);
  });

  it('каталог по дате: страница за пределами выдачи пуста, но total честный', async () => {
    const res = await cards(`?q=${marker}&limit=2&page=9`);

    expect(res.items).toEqual([]);
    expect(res.pagination.total).toBe(3);
    expect(res.pagination.totalPages).toBe(2);
  });
});
