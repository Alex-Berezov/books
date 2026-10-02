/* eslint-disable @typescript-eslint/no-unsafe-member-access -- тело ответа supertest сверх типизированного findTranslation остаётся необёрнутым (res.body.category/.tag, .seo) */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';
import { findTranslation } from './helpers/translations';

describe('Tag Translation Content & SEO (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let tagId: string;
  let versionId: string;

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

    // Create book + version for public endpoint tests
    const book = await createBookFixture(prisma, `book-tag-seo-${Date.now()}`);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Test Book Tag',
        author: 'Test Author',
        description: 'Test Description',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
      },
    });
    versionId = version.id;

    // Login admin
    const password = 'password123';
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

    // Create tag
    const tagRes = await request(http())
      .post('/tags')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        name: 'Bestseller',
        slug: `bestseller-seo-${Date.now()}`,
        key: `bestseller-seo-${Date.now()}`,
      })
      .expect(201);
    tagId = tagRes.body.id as string;

    // Attach tag to version
    await request(http())
      .post(`/versions/${versionId}/tags`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ tagId })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('should create tag translation with description and seo', async () => {
    const slug = `bestseller-en-seo-${Date.now()}`;
    const res = await request(http())
      .post(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        language: 'en',
        name: 'Bestseller',
        slug,
        description: '<p>Top selling books</p>',
        seo: {
          metaTitle: 'Bestseller Books',
          metaDescription: 'Browse our bestsellers',
        },
      })
      .expect(201);

    expect(res.body.description).toBe('<p>Top selling books</p>');
    expect(res.body.seoId).toBeDefined();
    expect(res.body.seo).toBeDefined();
    expect(res.body.seo.metaTitle).toBe('Bestseller Books');
  });

  it('should create tag translation without seo (backward compat)', async () => {
    const slug = `bestseller-fr-${Date.now()}`;
    const res = await request(http())
      .post(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        language: 'fr',
        name: 'Best-seller',
        slug,
      })
      .expect(201);

    expect(res.body.seoId).toBeNull();
    expect(res.body.seo).toBeNull();
    expect(res.body.description).toBeNull();
  });

  it('should list tag translations with seo included', async () => {
    const res = await request(http())
      .get(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.total).toBe(res.body.items.length);
    const enTrans = findTranslation(res.body, 'en');
    expect(enTrans.seo).toBeDefined();
    expect(enTrans.description).toBe('<p>Top selling books</p>');
  });

  it('should update tag translation seo (patch existing)', async () => {
    const res = await request(http())
      .patch(`/tags/${tagId}/translations/en`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        seo: {
          metaTitle: 'Updated Bestseller',
          ogTitle: 'Bestseller OG',
        },
      })
      .expect(200);

    expect(res.body.seo.metaTitle).toBe('Updated Bestseller');
    expect(res.body.seo.ogTitle).toBe('Bestseller OG');
    expect(res.body.seo.metaDescription).toBe('Browse our bestsellers');
  });

  // `LEGACY-422`: плоские поля контента и `indexable` доходят до колонок перевода
  // (`indexable` — `T73`, решение арбитра 30.09.2026 по слову владельца).
  const CONTENT_FIELDS = {
    h1: 'Bestseller H1',
    shortDescription: 'Short blurb',
    metaTitle: 'Flat meta title',
    metaDescription: 'Flat meta description',
    ogTitle: 'Flat OG title',
    ogDescription: 'Flat OG description',
    ogImageUrl: 'https://example.com/og.jpg',
    ogImageAlt: 'OG alt',
    faq: [{ question: 'Q?', answer: 'A.' }],
  };

  it('should persist flat content fields and indexable on create', async () => {
    const slug = `bestseller-es-${Date.now()}`;
    const res = await request(http())
      .post(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ language: 'es', name: 'Superventas', slug, ...CONTENT_FIELDS, indexable: false })
      .expect(201);

    expect(res.body).toMatchObject(CONTENT_FIELDS);
    const row = await prisma.tagTranslation.findUniqueOrThrow({
      where: { tagId_language: { tagId, language: 'es' } },
    });
    expect(row).toMatchObject(CONTENT_FIELDS);
    expect(row.indexable).toBe(false);

    // Публичный список отдаёт флаг и в переводе, и в проекции на язык (`T73`): по нему
    // карта сайта, главная и хаб `/tags` решают так же, как robots страницы.
    type ListItem = {
      id: string;
      indexable: boolean;
      translations: Array<{ language: string; indexable?: boolean }>;
    };
    let item: ListItem | undefined;
    for (let page = 1; !item; page++) {
      const list = await request(http()).get('/es/tags').query({ page, limit: 100 }).expect(200);
      item = (list.body.items as ListItem[]).find((t) => t.id === tagId);
      if (page >= list.body.pagination.totalPages) break;
    }
    if (!item) throw new Error('tag under test is missing from GET /es/tags');
    expect(item.indexable).toBe(false);
    expect(item.translations.find((t) => t.language === 'es')?.indexable).toBe(false);

    // Страница тега отдаёт тот же свёрнутый флаг: по нему фронт решает robots,
    // когда SEO-бандл не ответил (`app/[lang]/tag/[tagSlug]/page.tsx`).
    const cards = await request(http())
      .get(`/es/tags/${slug}/books/cards`)
      .query({ includeTag: true })
      .expect(200);
    expect(cards.body.tag.indexable).toBe(false);

    // `NOT NULL` колонка: `null` на создании отбивает валидатор, а не Prisma пятисотым.
    await request(http())
      .post(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ language: 'pt', name: 'Mais vendidos', slug: `${slug}-pt`, indexable: null })
      .expect(400);
  });

  it('should persist flat content fields and indexable on update, clear faq with null', async () => {
    const res = await request(http())
      .patch(`/tags/${tagId}/translations/es`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ ...CONTENT_FIELDS, h1: 'Updated H1', indexable: true })
      .expect(200);
    expect(res.body.h1).toBe('Updated H1');

    const cleared = await request(http())
      .patch(`/tags/${tagId}/translations/es`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ faq: null, shortDescription: null })
      .expect(200);
    expect(cleared.body.faq).toBeNull();
    expect(cleared.body.shortDescription).toBeNull();
    expect(cleared.body.h1).toBe('Updated H1');

    const row = await prisma.tagTranslation.findUniqueOrThrow({
      where: { tagId_language: { tagId, language: 'es' } },
    });
    expect(row.faq).toBeNull();
    expect(row.shortDescription).toBeNull();
    expect(row.h1).toBe('Updated H1');
    // Выставлен первым PATCH и не сброшен вторым, где поля нет.
    expect(row.indexable).toBe(true);

    // `LEGACY-430`, `T87`: четыре строковых поля очищаются `null` так же, как `faq` выше.
    await request(http())
      .patch(`/tags/${tagId}/translations/es`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ h1: null, metaTitle: null, ogTitle: null, ogImageAlt: null })
      .expect(200);
    const emptied = await prisma.tagTranslation.findUniqueOrThrow({
      where: { tagId_language: { tagId, language: 'es' } },
    });
    expect(emptied).toMatchObject({ h1: null, metaTitle: null, ogTitle: null, ogImageAlt: null });

    // `NOT NULL` колонка: `null` отбивает валидатор, а не Prisma пятисотым.
    await request(http())
      .patch(`/tags/${tagId}/translations/es`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ indexable: null })
      .expect(400);
  });

  it('should clear seo when all fields are null', async () => {
    // First create seo on fr translation
    await request(http())
      .patch(`/tags/${tagId}/translations/fr`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ seo: { metaTitle: 'Temp FR' } })
      .expect(200);

    const frBefore = await request(http())
      .get(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const frTrans = findTranslation(frBefore.body, 'fr');
    const oldSeoId = frTrans.seoId;
    if (oldSeoId === null) {
      throw new Error('Expected fr tag translation to have seo before clearing it');
    }

    const res = await request(http())
      .patch(`/tags/${tagId}/translations/fr`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        seo: {
          metaTitle: null,
          metaDescription: null,
          canonicalUrl: null,
          robots: null,
          ogTitle: null,
          ogDescription: null,
          ogType: null,
          ogUrl: null,
          ogImageUrl: null,
          ogImageAlt: null,
          twitterCard: null,
          twitterSite: null,
          twitterCreator: null,
        },
      })
      .expect(200);

    expect(res.body.seoId).toBeNull();
    expect(res.body.seo).toBeNull();

    const orphanSeo = await prisma.seo.findUnique({ where: { id: oldSeoId } });
    expect(orphanSeo).toBeNull();
  });

  it('should resolve seo for type=tag', async () => {
    const translations = await request(http())
      .get(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const enTrans = findTranslation(translations.body, 'en');

    const res = await request(http())
      .get(`/en/seo/resolve?type=tag&id=${enTrans.slug}`)
      .expect(200);

    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.title).toBe('Updated Bestseller');

    // 🔴 `LEGACY-316`. Ветка `tag` была четвёртой копией сборки ответа и уже
    // разошлась с остальными тремя: `breadcrumbPath` она не отдавала вовсе.
    // У тега предков не бывает, поэтому список пуст — но он есть, и форма
    // ответа теперь одна на все четыре типа страниц термина.
    expect(res.body.breadcrumbPath).toEqual([]);
    expect(res.body.meta.canonicalUrl).toContain(`/en/tag/${enTrans.slug}`);
    expect(res.body.openGraph.url).toBe(res.body.meta.canonicalUrl);
    for (const link of res.body.hreflangs as Array<{ href: string }>) {
      expect(link.href).toContain('/tag/');
    }
  });

  it('should delete tag translation and clean up seo', async () => {
    const translations = await request(http())
      .get(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const enTrans = findTranslation(translations.body, 'en');
    const seoId = enTrans.seoId;

    await request(http())
      .delete(`/tags/${tagId}/translations/en`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    if (seoId) {
      const orphanSeo = await prisma.seo.findUnique({ where: { id: seoId } });
      expect(orphanSeo).toBeNull();
    }
  });
});
