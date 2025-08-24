/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Comments rate limit e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
  let userToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    // Enable rate limiting for tests
    process.env.RATE_LIMIT_ENABLED = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await prisma.book.create({ data: { slug: `book-rl-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 't',
        author: 'a',
        description: 'd',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    const email = `rl_${Date.now()}@ex.com`;
    const pass = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password: pass });
    if (reg.status === 201) userToken = reg.body.accessToken as string;
    else {
      const login = await request(http()).post('/auth/login').send({ email, password: pass });
      userToken = login.body.accessToken as string;
    }
  });

  afterAll(async () => {
    await app.close();
    delete process.env.RATE_LIMIT_ENABLED;
  });

  it('returns 429 when exceeding POST /comments rate limit', async () => {
    // default guard allows 10 per minute; attempt 11 quickly
    for (let i = 0; i < 10; i++) {
      await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ bookVersionId: versionId, text: `msg ${i}` })
        .expect(201);
    }
    await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ bookVersionId: versionId, text: 'overflow' })
      .expect(429);
  });
});
