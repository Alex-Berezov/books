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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await prisma.book.create({ data: { slug: `book-${Date.now()}` } });
    bookId = book.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Strongly typed helper to avoid unsafe any from Nest's getHttpServer()
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  it('create -> list -> get -> update -> delete', async () => {
    const createRes = await request(http())
      .post(`/books/${bookId}/versions`)
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

    const listRes = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBe(1);
    await request(http()).get(`/versions/${versionId}`).expect(200);
    await request(http()).patch(`/versions/${versionId}`).send({ title: 'Updated' }).expect(200);
    await request(http()).delete(`/versions/${versionId}`).expect(204);
  });

  it('enforces uniqueness (bookId, language)', async () => {
    const slug = `book-${Date.now()}-2`;
    const book = await prisma.book.create({ data: { slug } });
    await request(http())
      .post(`/books/${book.id}/versions`)
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
