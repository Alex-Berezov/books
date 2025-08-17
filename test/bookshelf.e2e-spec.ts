/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Bookshelf e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userAccess: string;
  let versionId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await prisma.book.create({ data: { slug: `book-shelf-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Title',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password }).expect(201);
    userAccess = reg.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires auth for bookshelf endpoints', async () => {
    await request(http()).get('/me/bookshelf').expect(401);
    await request(http()).post(`/me/bookshelf/${versionId}`).expect(401);
    await request(http()).delete(`/me/bookshelf/${versionId}`).expect(401);
  });

  it('allows user to add/list/remove versions in bookshelf with idempotency', async () => {
    // add
    await request(http())
      .post(`/me/bookshelf/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(201);

    // duplicate add is idempotent
    await request(http())
      .post(`/me/bookshelf/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(201);

    // list
    const list = await request(http())
      .get('/me/bookshelf?page=1&limit=10')
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    expect(list.body.page).toBe(1);
    expect(list.body.limit).toBe(10);
    expect(typeof list.body.total).toBe('number');
    expect(typeof list.body.hasNext).toBe('boolean');

    // remove (204 even if already removed)
    await request(http())
      .delete(`/me/bookshelf/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(204);

    // remove again still returns 204
    await request(http())
      .delete(`/me/bookshelf/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(204);
  });

  it('returns 404 if trying to add non existing version', async () => {
    await request(http())
      .post(`/me/bookshelf/${'not-existing-id'}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(404);
  });
});
