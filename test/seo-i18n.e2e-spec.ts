/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, PublicationStatus } from '@prisma/client';

describe('SEO resolve i18n (/:lang prefix) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('prefers path language for book SEO resolve and prefixes canonical with /:lang', async () => {
    const slug = `seo-i18n-${Date.now()}`;
    const book = await prisma.book.create({ data: { slug } });

    // Create EN and ES versions, only ES with SEO
    await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc EN',
        coverImageUrl: 'https://example.com/en.jpg',
        type: 'text',
        isFree: true,
        status: 'published' as PublicationStatus,
      },
    });
    const es = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.es,
        title: 'Title ES',
        author: 'Author',
        description: 'Desc ES',
        coverImageUrl: 'https://example.com/es.jpg',
        type: 'audio',
        isFree: false,
        status: 'published' as PublicationStatus,
      },
    });
    await prisma.seo
      .create({
        data: {
          metaTitle: 'ES Meta',
          metaDescription: 'ES Desc',
          ogTitle: 'ES OG',
          ogImageUrl: 'https://example.com/og.jpg',
          // link SEO to ES version
        },
      })
      .then(async (seo) => {
        await prisma.bookVersion.update({ where: { id: es.id }, data: { seoId: seo.id } });
      });

    const r = await request(http())
      .get(`/es/seo/resolve`)
      .query({ type: 'book', id: slug })
      .set('Accept-Language', 'en-US,en;q=0.9')
      .expect(200);

    expect(r.body.meta.title).toBeDefined();
    expect(r.body.meta.canonicalUrl).toMatch(new RegExp(`/es/books/${slug}$`));
    expect(r.body.openGraph.title).toBeDefined();
  });

  it('resolves page SEO with language prefix in canonical and language selection policy', async () => {
    const slug = `about-${Date.now()}`;
    const pageEn = await prisma.page.create({
      data: {
        slug,
        title: 'About EN',
        type: 'generic',
        content: 'EN',
        language: Language.en,
        status: 'published',
      },
    });
    const pageEs = await prisma.page.create({
      data: {
        slug,
        title: 'Sobre ES',
        type: 'generic',
        content: 'ES',
        language: Language.es,
        status: 'published',
      },
    });

    // If path lang=es, pick ES page and prefix canonical with /es/pages/slug
    const r = await request(http())
      .get(`/es/seo/resolve`)
      .query({ type: 'page', id: slug })
      .expect(200);
    expect(r.body.meta.canonicalUrl).toMatch(new RegExp(`/es/pages/${slug}$`));

    // If no path lang, prefer query lang over Accept-Language
    const r2 = await request(http())
      .get(`/seo/resolve`)
      .query({ type: 'page', id: slug, lang: 'en' })
      .set('Accept-Language', 'es-ES,es;q=0.9')
      .expect(200);
    expect(r2.body.meta.canonicalUrl).toMatch(new RegExp(`/en/pages/${slug}$`));

    // If neither query nor header match, fall back to default language; canonical still prefixed
    const r3 = await request(http())
      .get(`/seo/resolve`)
      .query({ type: 'page', id: slug })
      .set('Accept-Language', 'de-DE,de;q=0.9')
      .expect(200);
    // default is en in dev env, so expect /en prefix
    expect(r3.body.meta.canonicalUrl).toMatch(new RegExp(`/en/pages/${slug}$`));

    // Use created variables to avoid TS unused warnings
    expect([pageEn.id, pageEs.id].length).toBeGreaterThan(0);
  });
});
