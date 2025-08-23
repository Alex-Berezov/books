/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('ViewStats e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
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

    const book = await prisma.book.create({ data: { slug: `book-views-${Date.now()}` } });
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
      },
    });
    versionId = version.id;

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

  it('Aggregate and Top', async () => {
    // Create some historical views across days
    const now = new Date();
    const day1 = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();
    const day2 = new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString();
    await request(http())
      .post('/views')
      .send({ bookVersionId: versionId, source: 'text', timestamp: day1 });
    await request(http())
      .post('/views')
      .send({ bookVersionId: versionId, source: 'text', timestamp: day2 });

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
