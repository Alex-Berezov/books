import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';
import { createBookFixture } from './helpers/book-fixture';

/**
 * F02-3: страница автора отдаёт порцию 12 книг, а «Показать все» догружает остальное через
 * `/books/cards` тем же набором и порядком. Счёт и агрегаты шапки (аудио, средняя оценка)
 * — по всему набору: здесь аудио и оценка есть только у 13-й книги, за пределами порции.
 */
describe('Author page: portion of 12 and header aggregates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  const prefix = `author-portion-${stamp}`;
  const name = `Portion Author ${stamp}`;
  const slug = `${prefix}-ru`;
  const BOOKS = 13;
  let authorId = '';
  let userId = '';
  const bookIds: string[] = [];
  let draftBookId = '';

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
      data: { translations: { create: [{ language: Language.ru, slug, name }] } },
    });
    authorId = author.id;

    const user = await prisma.user.create({
      data: { email: `${prefix}@example.invalid`, languagePreference: Language.ru },
    });
    userId = user.id;

    // Годы 1900…1912: порядок по году задан однозначно, 13-я книга — последней.
    let lastVersionId = '';
    for (let i = 0; i < BOOKS; i += 1) {
      const book = await createBookFixture(prisma, `${prefix}-book-${i}`);
      bookIds.push(book.id);
      const version = await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language: Language.ru,
          title: `${prefix} ${String(i).padStart(2, '0')}`,
          author: name,
          authorId,
          description: 'd',
          coverImageUrl: 'https://example.com/c.png',
          type: 'text',
          isFree: true,
          status: 'published',
          firstPublishedYear: 1900 + i,
        },
      });
      lastVersionId = version.id;
    }

    await prisma.audioChapter.create({
      data: {
        bookVersionId: lastVersionId,
        number: 1,
        title: `${prefix} chapter`,
        audioUrl: 'https://example.invalid/audio.mp3',
        duration: 60,
      },
    });
    await prisma.bookRating.create({
      data: { userId, bookId: bookIds[BOOKS - 1], score: 3 },
    });

    // Черновик того же автора с оценкой 1: в набор, счёт и среднее шапки не входит.
    const draft = await createBookFixture(prisma, `${prefix}-draft`);
    draftBookId = draft.id;
    await prisma.bookVersion.create({
      data: {
        bookId: draft.id,
        language: Language.ru,
        title: `${prefix} draft`,
        author: name,
        authorId,
        description: 'd',
        coverImageUrl: 'https://example.com/c.png',
        type: 'text',
        isFree: true,
        status: 'draft',
        firstPublishedYear: 1850,
      },
    });
    await prisma.bookRating.create({ data: { userId, bookId: draft.id, score: 1 } });
  });

  afterAll(async () => {
    await prisma.bookRating.deleteMany({ where: { userId } });
    await prisma.bookVersion.deleteMany({ where: { bookId: { in: [...bookIds, draftBookId] } } });
    await prisma.book.deleteMany({ where: { id: { in: [...bookIds, draftBookId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.author.deleteMany({ where: { id: authorId } });
    await app.close();
  });

  type DetailBody = {
    booksTotal: number;
    booksHasAudio: boolean;
    booksAvgRating: number | null;
    books: Array<{ id: string; hasAudio: boolean; rating: number | null }>;
  };
  type CardsBody = { items: Array<{ id: string }>; pagination: { total: number } };

  it('serves the first 12 books in the same order as the first page of cards', async () => {
    const server = httpServerOf(app);
    const detail = (await request(server).get(`/ru/authors/${slug}`).expect(200))
      .body as DetailBody;
    const firstPage = (
      await request(server)
        .get(`/ru/authors/${slug}/books/cards`)
        .query({ page: 1, limit: 12 })
        .expect(200)
    ).body as CardsBody;

    expect(detail.books.map((b) => b.id)).toEqual(bookIds.slice(0, 12));
    expect(detail.books.map((b) => b.id)).toEqual(firstPage.items.map((b) => b.id));
    expect(detail.booksTotal).toBe(BOOKS);
    expect(firstPage.pagination.total).toBe(BOOKS);
  });

  // «Показать все» (решение арбитра 15.10.2026, `F02 | F02-3`, Р2): страницы по 48 отдают
  // весь набор, показанные 12 — его начало.
  it('serves the whole set in the same order through cards pages of 48', async () => {
    const all = (
      await request(httpServerOf(app))
        .get(`/ru/authors/${slug}/books/cards`)
        .query({ page: 1, limit: 48 })
        .expect(200)
    ).body as CardsBody;

    expect(all.items.map((b) => b.id)).toEqual(bookIds);
  });

  it('counts audio and rating over all books, not only the portion', async () => {
    const detail = (await request(httpServerOf(app)).get(`/ru/authors/${slug}`).expect(200))
      .body as DetailBody;

    expect(detail.books.some((b) => b.hasAudio)).toBe(false);
    expect(detail.books.some((b) => b.rating !== null)).toBe(false);
    expect(detail.booksHasAudio).toBe(true);
    expect(detail.booksAvgRating).toBe(3);
  });
});
