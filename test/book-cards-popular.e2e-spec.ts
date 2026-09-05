import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookType, Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

/**
 * `LEGACY-128`. Ветка `?sort=popular` в `GET /:lang/books/cards` считалась
 * в памяти процесса: из базы выбирались **все** опубликованные версии под
 * фильтр, рейтинги агрегировались по всему каталогу, страница отрезалась
 * `slice`. Теперь это один запрос с `LIMIT/OFFSET` и агрегатом на стороне базы.
 *
 * 🔴 Зачем e2e, если есть юниты. Юниты сверяют **текст** запроса: `$queryRaw`
 * там замокан и в Postgres ничего не уходит. Ошибка в самом операторе - каст,
 * приведение типа параметра, `DISTINCT ON` без совпадающего `ORDER BY` -
 * при зелёных юнитах вылезет 500 на публичной витрине. Здесь запрос
 * исполняется по-настоящему.
 *
 * Данные свои и помечены маркером: набор сидов меняется, и посадка не должна
 * от него зависеть. Все проверки сравнивают только помеченные книги.
 */
describe('Book cards: popular sort (LEGACY-128) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const marker = `pop${Date.now()}`;
  const bookIds: string[] = [];
  let userId = '';

  interface CardRow {
    id: string;
    slug: string;
    title: string;
  }

  interface CardsResponse {
    items: CardRow[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }

  /**
   * Три книги на одном языке: высокий рейтинг, низкий и без оценок вовсе.
   * Третья проверяет `COALESCE(avgScore, -1)` - книга без оценок обязана идти
   * после любой оценённой, а не выпасть из выдачи вместе с `LEFT JOIN`.
   */
  const seedBook = async (
    suffix: string,
    type: BookType,
    publishedAt: Date,
  ): Promise<{ bookId: string; versionId: string }> => {
    const book = await createBookFixture(prisma, `${marker}-${suffix}`);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.ru,
        title: `${marker} ${suffix}`,
        author: `${marker} author`,
        description: 'e2e',
        coverImageUrl: 'https://example.invalid/cover.png',
        type,
        isFree: true,
        status: 'published',
        publishedAt,
        slug: `${marker}-${suffix}`,
      },
    });
    bookIds.push(book.id);
    return { bookId: book.id, versionId: version.id };
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

    const high = await seedBook('high', BookType.text, new Date('2026-01-03T00:00:00Z'));
    const low = await seedBook('low', BookType.audio, new Date('2026-01-02T00:00:00Z'));
    await seedBook('none', BookType.text, new Date('2026-01-01T00:00:00Z'));

    // `type=audio` отбирает по наличию аудиоглав, а не по типу версии.
    await prisma.audioChapter.create({
      data: {
        bookVersionId: low.versionId,
        number: 1,
        title: `${marker} chapter`,
        audioUrl: 'https://example.invalid/audio.mp3',
        duration: 60,
      },
    });

    await prisma.bookRating.create({ data: { userId, bookId: high.bookId, score: 5 } });
    await prisma.bookRating.create({ data: { userId, bookId: low.bookId, score: 2 } });
  });

  afterAll(async () => {
    await prisma.bookRating.deleteMany({ where: { userId } });
    await prisma.audioChapter.deleteMany({
      where: { bookVersion: { bookId: { in: bookIds } } },
    });
    await prisma.bookVersion.deleteMany({ where: { bookId: { in: bookIds } } });
    await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const cards = async (query: string): Promise<CardsResponse> => {
    const res = await request(http()).get(`/ru/books/cards${query}`).expect(200);
    return res.body as CardsResponse;
  };

  it('отвечает 200, а не 500: запрос действительно исполняется в Postgres', async () => {
    const res = await cards(`?sort=popular&q=${marker}`);

    expect(res.pagination.total).toBe(3);
    expect(res.items).toHaveLength(3);
  });

  it('сортирует по рейтингу, а книгу без оценок ставит последней', async () => {
    const res = await cards(`?sort=popular&q=${marker}`);

    expect(res.items.map((item) => item.slug)).toEqual([
      `${marker}-high`,
      `${marker}-low`,
      `${marker}-none`,
    ]);
  });

  it('фильтр по типу доезжает до базы вместе с сортировкой', async () => {
    const res = await cards(`?sort=popular&q=${marker}&type=audio`);

    expect(res.pagination.total).toBe(1);
    expect(res.items.map((item) => item.slug)).toEqual([`${marker}-low`]);
  });

  /**
   * Страница берётся из базы, а не режется в процессе: вторая страница обязана
   * отдать оставшуюся книгу и тот же `total`, что и первая.
   */
  it('пагинация идёт по базе: страницы не пересекаются, total общий', async () => {
    const first = await cards(`?sort=popular&q=${marker}&limit=2&page=1`);
    const second = await cards(`?sort=popular&q=${marker}&limit=2&page=2`);

    expect(first.pagination.total).toBe(3);
    expect(second.pagination.total).toBe(3);
    expect(first.pagination.totalPages).toBe(2);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);

    const firstIds = first.items.map((item) => item.id);
    expect(second.items.some((item) => firstIds.includes(item.id))).toBe(false);
  });

  it('страница за пределами выборки пуста, но total честный', async () => {
    const res = await cards(`?sort=popular&q=${marker}&limit=2&page=9`);

    expect(res.items).toEqual([]);
    expect(res.pagination.total).toBe(3);
  });

  it('поиск, не совпавший ни с чем, отдаёт пустую страницу и ноль', async () => {
    const res = await cards(`?sort=popular&q=${marker}-nothing-matches`);

    expect(res.items).toEqual([]);
    expect(res.pagination).toEqual({ page: 1, limit: 24, total: 0, totalPages: 0 });
  });
});
