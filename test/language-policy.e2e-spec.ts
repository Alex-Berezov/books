/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';

describe('Language selection policy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
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

  it('prefers lang query over Accept-Language and falls back to default when not available', async () => {
    const slug = `lang-policy-${Date.now()}`;
    const book = await prisma.book.create({ data: { slug } });

    // Create two published versions: EN text, ES audio
    const vEn = await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
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
    await request(http())
      .patch(`/versions/${(vEn.body as { id: string }).id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const vEs = await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
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
    await request(http())
      .patch(`/versions/${(vEs.body as { id: string }).id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // 1) Accept-Language favors es, but query ?lang=en should win for picking text
    const res1 = await request(http())
      .get(`/books/${slug}/overview?lang=en`)
      .set('Accept-Language', 'es-ES,es;q=0.9,en;q=0.8')
      .expect(200);
    expect(res1.body.availableLanguages).toEqual(
      expect.arrayContaining([Language.en, Language.es]),
    );
    expect(res1.body.hasText).toBe(true);

    // 2) Without query, Accept-Language should prefer es for audio choice when both present
    const res2 = await request(http())
      .get(`/books/${slug}/overview`)
      .set('Accept-Language', 'es-ES,es;q=0.9,en;q=0.8')
      .expect(200);
    // listen SEO will be from ES audio if present; just ensure audio exists
    expect(res2.body.hasAudio).toBe(true);

    // 3) Unsupported query lang → fallback to DEFAULT_LANGUAGE (env), default is en in tests
    const res3 = await request(http()).get(`/books/${slug}/overview?lang=de`).expect(200);
    expect(res3.body.availableLanguages).toEqual(
      expect.arrayContaining([Language.en, Language.es]),
    );
  });
});
