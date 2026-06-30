/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Category Translation Content & SEO (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let categoryId: string;
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
    const book = await prisma.book.create({ data: { slug: `book-cat-seo-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Test Book',
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

    // Create category
    const catRes = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ type: 'category', name: 'Fiction', slug: `fiction-seo-${Date.now()}` })
      .expect(201);
    categoryId = catRes.body.id as string;

    // Attach category to version
    await request(http())
      .post(`/versions/${versionId}/categories`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ categoryId })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('should create translation with description and seo', async () => {
    const slug = `fiction-en-seo-${Date.now()}`;
    const res = await request(http())
      .post(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        language: 'en',
        name: 'Fiction',
        slug,
        description: '<p>Fiction books collection</p>',
        seo: {
          metaTitle: 'Fiction Books',
          metaDescription: 'Browse our fiction collection',
          robots: 'index, follow',
        },
      })
      .expect(201);

    expect(res.body.description).toBe('<p>Fiction books collection</p>');
    expect(res.body.seoId).toBeDefined();
    expect(res.body.seo).toBeDefined();
    expect(res.body.seo.metaTitle).toBe('Fiction Books');
    expect(res.body.seo.metaDescription).toBe('Browse our fiction collection');
  });

  it('should create translation without seo (backward compat)', async () => {
    const slug = `fiction-fr-${Date.now()}`;
    const res = await request(http())
      .post(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        language: 'fr',
        name: 'Fiction FR',
        slug,
      })
      .expect(201);

    expect(res.body.seoId).toBeNull();
    expect(res.body.seo).toBeNull();
    expect(res.body.description).toBeNull();
  });

  it('should list translations with seo included', async () => {
    const res = await request(http())
      .get(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const enTrans = res.body.find((t: any) => t.language === 'en');
    expect(enTrans).toBeDefined();
    expect(enTrans.seo).toBeDefined();
    expect(enTrans.description).toBe('<p>Fiction books collection</p>');
  });

  it('should update translation seo (patch existing)', async () => {
    const res = await request(http())
      .patch(`/categories/${categoryId}/translations/en`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        seo: {
          metaTitle: 'Updated Fiction Title',
          ogTitle: 'Fiction OG Title',
        },
      })
      .expect(200);

    expect(res.body.seo.metaTitle).toBe('Updated Fiction Title');
    expect(res.body.seo.ogTitle).toBe('Fiction OG Title');
    // existing field should remain
    expect(res.body.seo.metaDescription).toBe('Browse our fiction collection');
  });

  it('should create seo for translation that had none', async () => {
    const res = await request(http())
      .patch(`/categories/${categoryId}/translations/fr`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        description: '<p>Collection de fiction</p>',
        seo: {
          metaTitle: 'Fiction FR',
        },
      })
      .expect(200);

    expect(res.body.description).toBe('<p>Collection de fiction</p>');
    expect(res.body.seoId).toBeDefined();
    expect(res.body.seo.metaTitle).toBe('Fiction FR');
  });

  it('should clear seo when all fields are null', async () => {
    const frBefore = await request(http())
      .get(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const frTrans = frBefore.body.find((t: any) => t.language === 'fr');
    const oldSeoId = frTrans.seoId;

    const res = await request(http())
      .patch(`/categories/${categoryId}/translations/fr`)
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

    // Verify orphan seo is deleted
    const orphanSeo = await prisma.seo.findUnique({ where: { id: oldSeoId } });
    expect(orphanSeo).toBeNull();
  });

  it('should return description and seo in public endpoint', async () => {
    // Get the en translation slug
    const translations = await request(http())
      .get(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const enTrans = translations.body.find((t: any) => t.language === 'en');

    const res = await request(http()).get(`/en/categories/${enTrans.slug}/books`).expect(200);

    expect(res.body.category).toBeDefined();
    expect(res.body.category.description).toBe('<p>Fiction books collection</p>');
    expect(res.body.seo).toBeDefined();
    expect(res.body.seo.metaTitle).toBe('Updated Fiction Title');
  });

  it('should resolve seo for type=category', async () => {
    const translations = await request(http())
      .get(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const enTrans = translations.body.find((t: any) => t.language === 'en');

    const res = await request(http())
      .get(`/en/seo/resolve?type=category&id=${enTrans.slug}`)
      .expect(200);

    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.title).toBe('Updated Fiction Title');
  });

  it('should delete translation and clean up seo', async () => {
    // Get en translation seoId
    const translations = await request(http())
      .get(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const enTrans = translations.body.find((t: any) => t.language === 'en');
    const seoId = enTrans.seoId;

    await request(http())
      .delete(`/categories/${categoryId}/translations/en`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    // Verify seo is also deleted
    if (seoId) {
      const orphanSeo = await prisma.seo.findUnique({ where: { id: seoId } });
      expect(orphanSeo).toBeNull();
    }
  });
});
