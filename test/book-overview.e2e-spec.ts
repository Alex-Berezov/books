/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';

describe('Book Overview (e2e)', () => {
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

  it('returns aggregated overview with flags and SEO (published only)', async () => {
    const slug = `overview-${Date.now()}`;
    const book = await prisma.book.create({ data: { slug } });

    // Create text EN (draft) with SEO
    const createText = await request(http())
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
        seoMetaTitle: 'SEO Main EN',
        seoMetaDescription: 'SEO Desc EN',
      })
      .expect(201);
    const versionTextId = (createText.body as { id: string }).id;

    // Summary for text version
    await request(http())
      .put(`/versions/${versionTextId}/summary`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ summary: 'Short summary' })
      .expect(200);

    // Create audio ES (draft)
    const createAudio = await request(http())
      .post(`/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.es,
        title: 'Audio ES',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover2.jpg',
        type: BookType.audio,
        isFree: false,
        seoMetaTitle: 'SEO Audio ES',
        seoMetaDescription: 'SEO Audio Desc ES',
      })
      .expect(201);
    const versionAudioId = (createAudio.body as { id: string }).id;

    // Publish only text
    await request(http())
      .patch(`/versions/${versionTextId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Overview should show only text-related flags as true
    const res1 = await request(http()).get(`/books/${slug}/overview`).expect(200);
    expect(res1.body.book.slug).toBe(slug);
    expect(res1.body.hasText).toBe(true);
    expect(res1.body.hasAudio).toBe(false);
    expect(res1.body.versionIds.text).toBe(versionTextId);
    expect(res1.body.versionIds.audio).toBeNull();
    // availableLanguages includes only languages of published versions
    expect(res1.body.availableLanguages).toEqual([Language.en]);
    // seo.main populated from text version
    expect(res1.body.seo.main.metaTitle).toBe('SEO Main EN');
    expect(res1.body.hasSummary).toBe(true);

    // Now publish audio and re-check
    await request(http())
      .patch(`/versions/${versionAudioId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const res2 = await request(http()).get(`/books/${slug}/overview?lang=es`).expect(200);
    const langs = (res2.body.availableLanguages as string[]) || [];
    expect(new Set(langs)).toEqual(new Set([Language.en, Language.es]));
    expect(res2.body.hasAudio).toBe(true);
    expect(res2.body.versionIds.audio).toBe(versionAudioId);
    // lang=es prefers ES for audio SEO
    expect(res2.body.seo.listen.metaTitle).toBe('SEO Audio ES');
  });
});
