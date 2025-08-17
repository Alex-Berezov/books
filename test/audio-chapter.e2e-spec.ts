/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AudioChapters e2e', () => {
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

    const book = await prisma.book.create({ data: { slug: `book-audio-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Audio T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
      },
    });
    versionId = version.id;

    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const regUser = await request(http())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    userAccess = regUser.body.accessToken as string;

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

  it('forbids creating audio chapter without auth', async () => {
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .send({ number: 1, title: 'Ch1', audioUrl: 'https://example.com/a/1.mp3', duration: 100 })
      .expect(401);
  });

  it('forbids creating audio chapter for non-admin/non-manager user', async () => {
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ number: 1, title: 'Ch1', audioUrl: 'https://example.com/a/1.mp3', duration: 100 })
      .expect(403);
  });

  it('admin can CRUD audio chapter and pagination works', async () => {
    const created = await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 1, title: 'Ch1', audioUrl: 'https://example.com/a/1.mp3', duration: 100 })
      .expect(201);
    const id = created.body.id as string;

    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 2, title: 'Ch2', audioUrl: 'https://example.com/a/2.mp3', duration: 200 })
      .expect(201);

    const list1 = await request(http())
      .get(`/versions/${versionId}/audio-chapters?limit=1&page=1`)
      .expect(200);
    expect(list1.body.length).toBe(1);
    expect(list1.body[0].number).toBe(1);

    const list2 = await request(http())
      .get(`/versions/${versionId}/audio-chapters?limit=1&page=2`)
      .expect(200);
    expect(list2.body.length).toBe(1);
    expect(list2.body[0].number).toBe(2);

    await request(http()).get(`/audio-chapters/${id}`).expect(200);

    await request(http())
      .patch(`/audio-chapters/${id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ title: 'New Title' })
      .expect(200);

    await request(http())
      .delete(`/audio-chapters/${id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });

  it('enforces uniqueness of audio chapter number within version', async () => {
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'Ch3', audioUrl: 'https://example.com/a/3.mp3', duration: 150 })
      .expect(201);
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'Dup', audioUrl: 'https://example.com/a/3-dup.mp3', duration: 150 })
      .expect(400);
  });
});
