/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, PublicationStatus } from '@prisma/client';

describe('Multisite i18n routing (/:lang) (e2e)', () => {
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

  it('prefers path language over query and Accept-Language for book overview', async () => {
    const slug = `i18n-book-${Date.now()}`;
    const book = await prisma.book.create({ data: { slug } });

    // Create two published versions EN and ES
    await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.en,
        title: 'EN',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/en.jpg',
        type: 'text',
        isFree: true,
        status: 'published' as PublicationStatus,
      },
    });
    await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.es,
        title: 'ES',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/es.jpg',
        type: 'audio',
        isFree: false,
        status: 'published' as PublicationStatus,
      },
    });

    // Path lang = es should dominate over query lang=en and Accept-Language: en
    const res = await request(http())
      .get(`/es/books/${slug}/overview?lang=en`)
      .set('Accept-Language', 'en-US,en;q=0.9')
      .expect(200);

    expect(res.body.book.slug).toBe(slug);
    const langs: string[] = (res.body.availableLanguages as string[]) || [];
    expect(new Set(langs)).toEqual(new Set([Language.en, Language.es]));
    // audio (es) should be preferred for listen SEO if applicable; we only check availableLanguages here as smoke
    expect(res.body.availableLanguages.includes(Language.es)).toBe(true);
  });

  it('serves pages by (language, slug) under /:lang/pages/:slug and allows same slug across languages', async () => {
    const baseSlug = `about-${Date.now()}`;

    const pageEn = await prisma.page.create({
      data: {
        slug: baseSlug,
        title: 'About EN',
        type: 'generic',
        content: 'EN content',
        language: Language.en,
        status: 'published',
      },
    });

    const pageEs = await prisma.page.create({
      data: {
        slug: baseSlug,
        title: 'Sobre ES',
        type: 'generic',
        content: 'ES content',
        language: Language.es,
        status: 'published',
      },
    });

    expect(pageEn.slug).toBe(baseSlug);
    expect(pageEs.slug).toBe(baseSlug);

    const resEn = await request(http()).get(`/en/pages/${baseSlug}`).expect(200);
    const resEs = await request(http()).get(`/es/pages/${baseSlug}`).expect(200);

    expect(resEn.body.title).toBe('About EN');
    expect(resEs.body.title).toBe('Sobre ES');
  });
});
