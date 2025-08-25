/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';

// Response shape helper for stronger typing in assertions
interface BookVersionResponse {
  id: string;
  bookId: string;
  language: string;
  title: string;
  author: string;
  description: string;
  coverImageUrl: string;
  type: string;
  isFree: boolean;
  referralUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  seoId?: number | null;
}

describe('BookVersions e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bookId: string;
  let adminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    const book = await prisma.book.create({ data: { slug: `book-${Date.now()}` } });
    bookId = book.id;

    // ensure admin auth
    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // Strongly typed helper to avoid unsafe any from Nest's getHttpServer()
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  it('create (draft) -> public not visible -> admin sees -> publish -> public visible -> unpublish -> hide -> delete', async () => {
    const createRes = await request(http())
      .post(`/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const created: BookVersionResponse = createRes.body as BookVersionResponse;
    const versionId = created.id;

    // Public must not see draft
    const listDraftHidden = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(Array.isArray(listDraftHidden.body)).toBe(true);
    expect(listDraftHidden.body.length).toBe(0);
    await request(http()).get(`/versions/${versionId}`).expect(404);

    // Admin sees draft via admin route
    const adminList = await request(http())
      .get(`/admin/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(adminList.body.length).toBe(1);

    // Publish -> public should see now
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listAfterPublish = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(listAfterPublish.body.length).toBe(1);
    await request(http()).get(`/versions/${versionId}`).expect(200);

    // Unpublish -> public should hide again
    await request(http())
      .patch(`/versions/${versionId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listAfterUnpublish = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(listAfterUnpublish.body.length).toBe(0);
    await request(http()).get(`/versions/${versionId}`).expect(404);
    // Update still works via admin
    await request(http())
      .patch(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Updated' })
      .expect(200);
    await request(http())
      .delete(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });

  it('enforces uniqueness (bookId, language)', async () => {
    const slug = `book-${Date.now()}-2`;
    const book = await prisma.book.create({ data: { slug } });
    await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN 2',
        author: 'Author 2',
        description: 'Desc 2',
        coverImageUrl: 'https://example.com/cover2.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(400);
  });
});
