/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';

// This test validates language selection policy on category and tag listing endpoints

describe('Language policy on categories/tags listings (e2e)', () => {
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

  it('filters by ?lang and Accept-Language with fallback', async () => {
    // Create book with two versions EN (text) and ES (audio)
    const slug = `lang-cat-tag-${Date.now()}`;
    const book = await prisma.book.create({ data: { slug } });

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
        seoMetaTitle: 'SEO EN',
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
        seoMetaTitle: 'SEO ES',
      })
      .expect(201);
    const vESid = (vES.body as { id: string }).id;

    // Publish both
    await request(http())
      .patch(`/versions/${vENid}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    await request(http())
      .patch(`/versions/${vESid}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    // Create category and tag, attach to both versions
    const category = await prisma.category.create({
      data: { type: 'genre', name: `LangCat ${Date.now()}`, slug: `lang-cat-${Date.now()}` },
    });
    await prisma.bookCategory.create({ data: { bookVersionId: vENid, categoryId: category.id } });
    await prisma.bookCategory.create({ data: { bookVersionId: vESid, categoryId: category.id } });

    const tag = await prisma.tag.create({
      data: { name: `LangTag ${Date.now()}`, slug: `lang-tag-${Date.now()}` },
    });
    await prisma.bookTag.create({ data: { bookVersionId: vENid, tagId: tag.id } });
    await prisma.bookTag.create({ data: { bookVersionId: vESid, tagId: tag.id } });

    // Categories: ?lang=en -> only EN
    const resCatEN = await request(http())
      .get(`/categories/${category.slug}/books?lang=en`)
      .expect(200);
    expect(resCatEN.body.availableLanguages).toEqual(expect.arrayContaining(['en', 'es']));
    expect(resCatEN.body.versions.every((v: any) => v.language === 'en')).toBe(true);

    // Categories: Accept-Language es -> only ES
    const resCatES = await request(http())
      .get(`/categories/${category.slug}/books`)
      .set('Accept-Language', 'es-ES,es;q=0.9,en;q=0.8')
      .expect(200);
    expect(resCatES.body.versions.every((v: any) => v.language === 'es')).toBe(true);

    // Tags: ?lang=es -> only ES
    const resTagES = await request(http()).get(`/tags/${tag.slug}/books?lang=es`).expect(200);
    expect(resTagES.body.versions.every((v: any) => v.language === 'es')).toBe(true);

    // Tags: unsupported Accept-Language -> fallback to default (en by default)
    const resTagFallback = await request(http())
      .get(`/tags/${tag.slug}/books`)
      .set('Accept-Language', 'de-DE,de;q=0.9')
      .expect(200);
    // default is en unless overridden
    expect(resTagFallback.body.versions.every((v: any) => v.language === 'en')).toBe(true);
  });
});
