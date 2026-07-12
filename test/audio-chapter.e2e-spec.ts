/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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
    expect(list1.body.items.length).toBe(1);
    expect(list1.body.items[0].number).toBe(1);
    expect(list1.body.total).toBeGreaterThanOrEqual(2);
    expect(list1.body.page).toBe(1);
    expect(list1.body.limit).toBe(1);
    expect(list1.body.totalPages).toBeGreaterThanOrEqual(2);

    const list2 = await request(http())
      .get(`/versions/${versionId}/audio-chapters?limit=1&page=2`)
      .expect(200);
    expect(list2.body.items.length).toBe(1);
    expect(list2.body.items[0].number).toBe(2);

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

  it('enforces uniqueness of audio chapter number within version (409 Conflict)', async () => {
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'Ch3', audioUrl: 'https://example.com/a/3.mp3', duration: 150 })
      .expect(201);
    const dup = await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'Dup', audioUrl: 'https://example.com/a/3-dup.mp3', duration: 150 })
      .expect(409);
    expect(dup.body.field).toBe('number');
  });

  it('supports description, transcript, mediaId fields', async () => {
    const res = await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        number: 10,
        title: 'Ch10',
        audioUrl: 'https://example.com/a/10.mp3',
        duration: 300,
        description: 'Short intro to the chapter.',
        transcript: '# Full transcript\nHello world.',
      })
      .expect(201);
    expect(res.body.description).toBe('Short intro to the chapter.');
    expect(res.body.transcript).toContain('Full transcript');
    expect(res.body.updatedAt).toBeDefined();
  });

  it('rejects invalid mediaId', async () => {
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        number: 11,
        title: 'Ch11',
        audioUrl: 'https://example.com/a/11.mp3',
        duration: 300,
        mediaId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(400);
  });

  it('validates duration bounds and title length', async () => {
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 20, title: 'X', audioUrl: 'https://example.com/a/x.mp3', duration: 999999 })
      .expect(400);
    await request(http())
      .post(`/versions/${versionId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 21, title: '', audioUrl: 'https://example.com/a/x.mp3', duration: 100 })
      .expect(400);
  });

  it('reorders audio chapters atomically', async () => {
    // Create a fresh version with 3 chapters for deterministic reorder
    const book = await prisma.book.create({ data: { slug: `book-audio-reorder-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Reorder',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
      },
    });
    const a = await request(http())
      .post(`/versions/${version.id}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 1, title: 'A', audioUrl: 'https://example.com/a.mp3', duration: 10 })
      .expect(201);
    const b = await request(http())
      .post(`/versions/${version.id}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 2, title: 'B', audioUrl: 'https://example.com/b.mp3', duration: 10 })
      .expect(201);
    const c = await request(http())
      .post(`/versions/${version.id}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'C', audioUrl: 'https://example.com/c.mp3', duration: 10 })
      .expect(201);

    const reorder = await request(http())
      .post(`/versions/${version.id}/audio-chapters/reorder`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ audioChapterIds: [c.body.id, a.body.id, b.body.id] })
      .expect(201);
    expect(reorder.body.map((x: { title: string }) => x.title)).toEqual(['C', 'A', 'B']);

    // Rejects mismatched set
    await request(http())
      .post(`/versions/${version.id}/audio-chapters/reorder`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ audioChapterIds: [a.body.id, b.body.id] })
      .expect(400);
  });

  it('admin endpoint returns chapters for draft versions; public list returns 404', async () => {
    const book = await prisma.book.create({ data: { slug: `book-audio-draft-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Draft',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
        status: 'draft',
      },
    });
    const created = await request(http())
      .post(`/versions/${version.id}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 1, title: 'D1', audioUrl: 'https://example.com/d/1.mp3', duration: 60 })
      .expect(201);

    // Public list: 404 because version is draft
    await request(http()).get(`/versions/${version.id}/audio-chapters`).expect(404);
    // Public get: 404
    await request(http()).get(`/audio-chapters/${created.body.id}`).expect(404);

    // Admin list/get: works
    const adminList = await request(http())
      .get(`/admin/versions/${version.id}/audio-chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(adminList.body.items.length).toBe(1);

    await request(http())
      .get(`/admin/audio-chapters/${created.body.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
  });
});
