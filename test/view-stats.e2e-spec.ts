/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

describe('ViewStats e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
  let draftVersionId: string;
  let userAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await createBookFixture(prisma, `book-views-${Date.now()}`);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
      },
    });
    versionId = version.id;

    // Черновик — для анонима его нет (LEGACY-462): ни записи просмотра, ни строки в топе.
    const draftBook = await createBookFixture(prisma, `book-views-draft-${Date.now()}`);
    const draft = await prisma.bookVersion.create({
      data: {
        bookId: draftBook.id,
        language: 'en',
        title: 'Draft',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: 'draft',
      },
    });
    draftVersionId = draft.id;

    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const regUser = await request(http()).post('/auth/register').send({ email, password });
    if (regUser.status === 201) {
      userAccess = regUser.body.accessToken as string;
    } else if (regUser.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      userAccess = login.body.accessToken as string;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /views anonymous and authorized', async () => {
    await request(http())
      .post('/views')
      .send({ bookVersionId: versionId, source: 'text' })
      .expect(201)
      .expect((r) => expect(r.body.success).toBe(true));

    await request(http())
      .post('/views')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ bookVersionId: versionId, source: 'text' })
      .expect(201);
  });

  it('POST /views 404 on wrong version', async () => {
    await request(http())
      .post('/views')
      .send({ bookVersionId: '00000000-0000-0000-0000-000000000000', source: 'text' })
      .expect(404);
  });

  it('POST /views 400 on bad source', async () => {
    await request(http())
      .post('/views')
      .send({ bookVersionId: versionId, source: 'bad' })
      .expect(400);
  });

  it('POST /views 404 on a draft version (LEGACY-462)', async () => {
    await request(http())
      .post('/views')
      .send({ bookVersionId: draftVersionId, source: 'text' })
      .expect(404);
    await expect(prisma.viewStat.count({ where: { bookVersionId: draftVersionId } })).resolves.toBe(
      0,
    );
  });

  it('POST /views rejects a client timestamp: the time is the server one (LEGACY-462)', async () => {
    await request(http())
      .post('/views')
      .send({ bookVersionId: versionId, source: 'text', timestamp: '2020-01-01T00:00:00Z' })
      .expect(400);
  });

  it('GET /views/top lists only published versions (LEGACY-462)', async () => {
    // Просмотры черновика, записанные до правки, — прямо в таблицу: через ручку их больше не записать.
    await prisma.viewStat.createMany({
      data: Array.from({ length: 50 }, () => ({
        bookVersionId: draftVersionId,
        source: 'text' as const,
        timestamp: new Date(),
      })),
    });
    const top = await request(http())
      .get('/views/top')
      .query({ period: 'week', limit: 50 })
      .expect(200);
    const ids = (top.body.items as { bookVersionId: string }[]).map((i) => i.bookVersionId);
    expect(ids).not.toContain(draftVersionId);
  });

  it('GET /views/aggregate gives a draft the same empty series as a missing id (LEGACY-471)', async () => {
    // Просмотры черновика, записанные до LEGACY-462, — прямо в таблицу.
    await prisma.viewStat.createMany({
      data: [{ bookVersionId: draftVersionId, source: 'text', timestamp: new Date() }],
    });
    const agg = await request(http())
      .get('/views/aggregate')
      .query({ versionId: draftVersionId, period: 'week' })
      .expect(200);
    expect(agg.body).toEqual({ total: 0, series: [] });
  });

  it('Aggregate and Top', async () => {
    // Исторические просмотры по дням — прямо в таблицу: `POST /views` пишет только текущее время.
    const now = new Date();
    const day1 = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    const day2 = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
    await prisma.viewStat.createMany({
      data: [
        { bookVersionId: versionId, source: 'text', timestamp: day1 },
        { bookVersionId: versionId, source: 'text', timestamp: day2 },
      ],
    });

    const agg = await request(http())
      .get('/views/aggregate')
      .query({ versionId, period: 'week' })
      .expect(200);
    expect(agg.body.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(agg.body.series)).toBe(true);

    const top = await request(http())
      .get('/views/top')
      .query({ period: 'week', limit: 5 })
      .expect(200);
    expect(Array.isArray(top.body.items)).toBe(true);
    expect(top.body.items.length).toBeGreaterThan(0);
  });
});
