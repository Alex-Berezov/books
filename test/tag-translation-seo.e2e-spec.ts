/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

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
    const book = await prisma.book.create({ data: { slug: `book-tag-seo-${Date.now()}` } });
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

    expect(Array.isArray(res.body)).toBe(true);
    const enTrans = res.body.find((t: any) => t.language === 'en');
    expect(enTrans).toBeDefined();
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
    const frTrans = frBefore.body.find((t: any) => t.language === 'fr');
    const oldSeoId = frTrans.seoId;

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
    const enTrans = translations.body.find((t: any) => t.language === 'en');

    const res = await request(http())
      .get(`/en/seo/resolve?type=tag&id=${enTrans.slug}`)
      .expect(200);

    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.title).toBe('Updated Bestseller');
  });

  it('should delete tag translation and clean up seo', async () => {
    const translations = await request(http())
      .get(`/tags/${tagId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const enTrans = translations.body.find((t: any) => t.language === 'en');
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
