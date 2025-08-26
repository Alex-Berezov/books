/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';

describe('Public versions list — Accept-Language fallback (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

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

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      admin = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      admin = login.body.accessToken as string;
    } else {
      throw new Error('Admin auth failed');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('prefers Accept-Language when no explicit language query provided', async () => {
    const book = await prisma.book.create({ data: { slug: `list-lang-${Date.now()}` } });

    const vEN = await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        language: Language.en,
        title: 'EN Text',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/en.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const vENid = (vEN.body as { id: string }).id;

    const vES = await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        language: Language.es,
        title: 'ES Audio',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/es.jpg',
        type: BookType.audio,
        isFree: false,
      })
      .expect(201);
    const vESid = (vES.body as { id: string }).id;

    await request(http())
      .patch(`/versions/${vENid}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    await request(http())
      .patch(`/versions/${vESid}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    const resES = await request(http())
      .get(`/books/${book.id}/versions`)
      .set('Accept-Language', 'es-ES,es;q=0.9,en;q=0.8')
      .expect(200);
    expect(resES.body.every((v: any) => v.language === 'es')).toBe(true);

    const resEN = await request(http())
      .get(`/books/${book.id}/versions`)
      .set('Accept-Language', 'en-US,en;q=0.9')
      .expect(200);
    expect(resEN.body.every((v: any) => v.language === 'en')).toBe(true);
  });
});
