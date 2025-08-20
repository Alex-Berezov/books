/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('ReadingProgress e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userAccess: string;
  let versionId: string;
  let audioVersionId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Seed: book with text chapters and audio chapters in separate versions
    const book = await prisma.book.create({ data: { slug: `rp-${Date.now()}` } });
    const textVersion = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Text Title',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = textVersion.id;
    await prisma.chapter.createMany({
      data: [
        { bookVersionId: versionId, number: 1, title: 'Ch1', content: '...' },
        { bookVersionId: versionId, number: 2, title: 'Ch2', content: '...' },
      ],
    });

    const audioVersion = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'es',
        title: 'Audio Title',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
      },
    });
    audioVersionId = audioVersion.id;
    await prisma.audioChapter.createMany({
      data: [
        {
          bookVersionId: audioVersionId,
          number: 1,
          title: 'A1',
          audioUrl: 'https://ex/a1.mp3',
          duration: 120,
        },
        {
          bookVersionId: audioVersionId,
          number: 2,
          title: 'A2',
          audioUrl: 'https://ex/a2.mp3',
          duration: 300,
        },
      ],
    });

    const email = `rp_${Date.now()}@example.com`;
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password }).expect(201);
    userAccess = reg.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires auth for reading-progress endpoints', async () => {
    await request(http()).get(`/me/progress/${versionId}`).expect(401);
    await request(http())
      .put(`/me/progress/${versionId}`)
      .send({ chapterNumber: 1, position: 0.5 })
      .expect(401);
  });

  it('text: upsert and fetch progress with validation on position (0..1)', async () => {
    // invalid: both fields provided
    await request(http())
      .put(`/me/progress/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ chapterNumber: 1, audioChapterNumber: 1, position: 0.5 })
      .expect(400);

    // invalid: position > 1 for text
    await request(http())
      .put(`/me/progress/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ chapterNumber: 1, position: 1.5 })
      .expect(400);

    // valid upsert
    const up1 = await request(http())
      .put(`/me/progress/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ chapterNumber: 2, position: 0.3 })
      .expect(200);
    expect(up1.body.chapterNumber).toBe(2);
    expect(up1.body.audioChapterNumber).toBeNull();
    expect(up1.body.position).toBeCloseTo(0.3);

    // get
    const got = await request(http())
      .get(`/me/progress/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(200);
    expect(got.body.chapterNumber).toBe(2);
    expect(got.body.audioChapterNumber).toBeNull();
    expect(got.body.position).toBeCloseTo(0.3);
  });

  it('audio: upsert and fetch progress with duration range', async () => {
    // invalid: position beyond duration
    await request(http())
      .put(`/me/progress/${audioVersionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ audioChapterNumber: 1, position: 999 })
      .expect(400);

    // valid upsert
    const up = await request(http())
      .put(`/me/progress/${audioVersionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ audioChapterNumber: 2, position: 120 })
      .expect(200);
    expect(up.body.audioChapterNumber).toBe(2);
    expect(up.body.chapterNumber).toBeNull();
    expect(up.body.position).toBe(120);

    const got = await request(http())
      .get(`/me/progress/${audioVersionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(200);
    expect(got.body.audioChapterNumber).toBe(2);
    expect(got.body.chapterNumber).toBeNull();
    expect(got.body.position).toBe(120);
  });

  it('returns 404 if version/chapter/audio-chapter not found', async () => {
    // non-existing version
    await request(http())
      .put(`/me/progress/not-existing`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ chapterNumber: 1, position: 0.5 })
      .expect(404);

    // non-existing chapter
    await request(http())
      .put(`/me/progress/${versionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ chapterNumber: 999, position: 0.5 })
      .expect(404);

    // non-existing audio chapter
    await request(http())
      .put(`/me/progress/${audioVersionId}`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ audioChapterNumber: 999, position: 1 })
      .expect(404);
  });
});
