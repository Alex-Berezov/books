/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('BookVersion preview e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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

    await request(http()).post('/api/auth/register').send({
      email: 'admin@example.com',
      password: 'Password1!',
      name: 'Admin',
    });
    const adminLogin = await request(http())
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'Password1!' });
    adminAccess = adminLogin.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /versions/:id/preview returns 404 when no preview set', async () => {
    const book = await prisma.book.create({ data: { slug: `book-prev-none-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
        status: 'published',
        publishedAt: new Date(),
      },
    });
    const res = await request(http()).get(`/api/versions/${version.id}/preview`);
    expect(res.status).toBe(404);
  });

  it('PATCH admin rejects non-audio previewMediaId; accepts audio; GET /preview returns metadata', async () => {
    const book = await prisma.book.create({ data: { slug: `book-prev-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
        status: 'published',
        publishedAt: new Date(),
      },
    });
    const image = await prisma.mediaAsset.create({
      data: {
        key: `img-prev-${Date.now()}.jpg`,
        url: 'http://localhost:5000/img.jpg',
        contentType: 'image/jpeg',
        size: 10,
      },
    });
    const audio = await prisma.mediaAsset.create({
      data: {
        key: `audio-prev-${Date.now()}.mp3`,
        url: 'http://localhost:5000/audio.mp3',
        contentType: 'audio/mpeg',
        size: 20,
        duration: 30,
      },
    });

    const bad = await request(http())
      .patch(`/api/admin/versions/${version.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ previewMediaId: image.id });
    expect(bad.status).toBe(400);

    const ok = await request(http())
      .patch(`/api/admin/versions/${version.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ previewMediaId: audio.id });
    expect(ok.status).toBe(200);

    const preview = await request(http()).get(`/api/versions/${version.id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.previewUrl).toBe(audio.url);
    expect(preview.body.duration).toBe(30);
    expect(preview.body.contentType).toBe('audio/mpeg');
  });

  it('FK SET NULL: deleting previewMedia clears previewMediaId', async () => {
    const book = await prisma.book.create({ data: { slug: `book-fk-${Date.now()}` } });
    const audio = await prisma.mediaAsset.create({
      data: {
        key: `audio-fk-${Date.now()}.mp3`,
        url: 'http://localhost:5000/a.mp3',
        contentType: 'audio/mpeg',
        size: 20,
      },
    });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
        previewMediaId: audio.id,
      },
    });
    await prisma.mediaAsset.delete({ where: { id: audio.id } });
    const refreshed = await prisma.bookVersion.findUnique({ where: { id: version.id } });
    expect(refreshed?.previewMediaId).toBeNull();
  });
});
