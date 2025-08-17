/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('BookSummary e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
  let userAccess: string;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await prisma.book.create({ data: { slug: `book-sum-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Version For Summary',
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
    const regUser = await request(http()).post('/auth/register').send({ email, password });
    if (regUser.status === 201) {
      userAccess = regUser.body.accessToken as string;
    } else if (regUser.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      userAccess = login.body.accessToken as string;
    }

    const adminEmail = 'admin@example.com';
    const regAdmin = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password });
    if (regAdmin.status === 201) {
      adminAccess = regAdmin.body.accessToken as string;
    } else if (regAdmin.status === 409) {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: adminEmail, password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    } else {
      throw new Error('Admin register failed');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET returns null when no summary exists', async () => {
    const res = await request(http()).get(`/versions/${versionId}/summary`).expect(200);
    const isNull = res.body === null;
    const bodyObj = (res.body ?? {}) as Record<string, unknown>;
    const isEmptyObj =
      typeof res.body === 'object' && res.body !== null && Object.keys(bodyObj).length === 0;
    expect(isNull || isEmptyObj).toBe(true);
  });

  it('PUT requires auth and proper role', async () => {
    await request(http()).put(`/versions/${versionId}/summary`).send({ summary: 'S' }).expect(401);

    await request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ summary: 'S' })
      .expect(403);
  });

  it('Admin can upsert summary and GET returns data', async () => {
    const payload1 = {
      summary: 'Short summary',
      analysis: 'Some analysis',
      themes: 'theme1, theme2',
    };

    const put1 = await request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload1)
      .expect(200);

    expect(put1.body.summary).toBe('Short summary');

    const get1 = await request(http()).get(`/versions/${versionId}/summary`).expect(200);
    expect(get1.body.summary).toBe('Short summary');

    const payload2 = { summary: 'Updated summary' };
    const put2 = await request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload2)
      .expect(200);

    expect(put2.body.summary).toBe('Updated summary');
  });
});
