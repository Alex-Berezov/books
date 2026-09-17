import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookType, Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PAGINATION_MAX_LIMIT } from '../src/shared/dto/pagination.dto';
import { createBookFixture } from './helpers/book-fixture';

/**
 * `LEGACY-377`. Анонимный `GET /:lang/categories/:slug/books` выбирал все книги категории
 * без `take`, а `meta` обещал `page: 1, limit: 100`, которых в запросе не было.
 *
 * Посадка проверяет достижимость: обход страниц даёт ровно `total` разных книг, а `total`
 * равен числу засеянных книг — усечение без сигнала здесь было бы тем же дефектом
 * с другой стороны (`LEGACY-098`).
 */
type ListBody = {
  data: Array<{ id: string }>;
  meta: { page: number; limit: number; total: number; totalPages: number };
};

describe('Public category books pagination (LEGACY-377) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const marker = `ccb-${Date.now()}`;
  const SEEDED = 5;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const category = await prisma.category.create({
      data: { type: 'genre', name: marker, slug: marker, key: marker },
    });
    for (let i = 0; i < SEEDED; i += 1) {
      const book = await createBookFixture(prisma, `${marker}-${i}`);
      const version = await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language: Language.en,
          title: `${marker} ${i}`,
          author: 'A',
          description: 'D',
          coverImageUrl: 'https://example.com/c.jpg',
          type: BookType.text,
          isFree: true,
          status: 'published',
        },
      });
      await prisma.bookCategory.create({
        data: { bookVersionId: version.id, categoryId: category.id },
      });
    }
  });

  afterAll(async () => {
    await prisma.bookCategory.deleteMany({ where: { category: { slug: marker } } });
    await prisma.bookVersion.deleteMany({ where: { book: { slug: { startsWith: marker } } } });
    await prisma.book.deleteMany({ where: { slug: { startsWith: marker } } });
    await prisma.category.deleteMany({ where: { slug: marker } });
    await app.close();
  });

  const list = async (query: string): Promise<ListBody> => {
    const res = await request(http()).get(`/en/categories/${marker}/books${query}`).expect(200);
    return res.body as ListBody;
  };

  it('pages the books and reports the applied page, limit and the real total', async () => {
    const first = await list('?page=1&limit=2');
    expect(first.data).toHaveLength(2);
    expect(first.meta).toEqual({ page: 1, limit: 2, total: SEEDED, totalPages: 3 });

    const last = await list('?page=3&limit=2');
    expect(last.data).toHaveLength(1);
  });

  it('makes every book reachable: walking the pages yields exactly total distinct books', async () => {
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      for (const row of (await list(`?page=${page}&limit=2`)).data) seen.add(row.id);
    }
    expect(seen.size).toBe(SEEDED);
  });

  it('answers an empty page past the end with the honest total', async () => {
    const beyond = await list('?page=10&limit=2');
    expect(beyond.data).toEqual([]);
    expect(beyond.meta.total).toBe(SEEDED);
  });

  it('refuses a limit above the ceiling with 400', async () => {
    await request(http()).get(`/en/categories/${marker}/books?limit=100000`).expect(400);
    await request(http())
      .get(`/en/categories/${marker}/books?limit=${PAGINATION_MAX_LIMIT + 1}`)
      .expect(400);
  });
});
