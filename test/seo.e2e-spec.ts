/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Seo e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
  let userAccess: string;
  let adminAccess: string;

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

    const book = await prisma.book.create({ data: { slug: `book-seo-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Version For SEO',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const regUser = await request(http()).post('/auth/register').send({ email, password });
    if (regUser.status === 201) {
      userAccess = regUser.body.accessToken as string;
    } else if (regUser.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      userAccess = login.body.accessToken as string;
    }

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET returns empty when no SEO exists', async () => {
    const res = await request(http()).get(`/versions/${versionId}/seo`).expect(200);
    const isNull = res.body === null;
    const bodyObj = (res.body ?? {}) as Record<string, unknown>;
    const isEmptyObj =
      typeof res.body === 'object' && res.body !== null && Object.keys(bodyObj).length === 0;
    expect(isNull || isEmptyObj).toBe(true);
  });

  it('PUT requires auth and proper role', async () => {
    await request(http()).put(`/versions/${versionId}/seo`).send({ metaTitle: 'T1' }).expect(401);

    await request(http())
      .put(`/versions/${versionId}/seo`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ metaTitle: 'T1' })
      .expect(403);
  });

  it('Admin can upsert SEO and GET returns data', async () => {
    const payload1 = {
      metaTitle: 'Title 1',
      metaDescription: 'Desc 1',
      canonicalUrl: 'https://example.com/book',
      ogTitle: 'OG T',
      ogUrl: 'https://example.com/book',
      ogImageUrl: 'https://example.com/img.jpg',
      eventName: 'Launch',
      eventStartDate: '2025-08-20T10:00:00.000Z',
      eventEndDate: '2025-08-21T10:00:00.000Z',
      eventUrl: 'https://example.com/event',
      eventImageUrl: 'https://example.com/event.jpg',
    };

    const put1 = await request(http())
      .put(`/versions/${versionId}/seo`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload1)
      .expect(200);

    expect(put1.body.id).toBeDefined();
    expect(put1.body.metaTitle).toBe('Title 1');

    const get1 = await request(http()).get(`/versions/${versionId}/seo`).expect(200);
    expect(get1.body.metaTitle).toBe('Title 1');
    expect(get1.body.eventStartDate).toBeDefined();

    const payload2 = {
      metaTitle: 'Title 2',
      ogDescription: 'OG Desc',
      twitterCard: 'summary_large_image',
    };

    const put2 = await request(http())
      .put(`/versions/${versionId}/seo`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload2)
      .expect(200);

    expect(put2.body.metaTitle).toBe('Title 2');

    const get2 = await request(http()).get(`/versions/${versionId}/seo`).expect(200);
    expect(get2.body.metaTitle).toBe('Title 2');
    expect(get2.body.ogDescription).toBe('OG Desc');
  });

  it('GET /seo/resolve returns bundle for version and book (fallback)', async () => {
    // Version resolve
    const r1 = await request(http())
      .get('/seo/resolve')
      .query({ type: 'version', id: versionId })
      .expect(200);
    expect(r1.body.meta.title).toBeDefined();
    expect(r1.body.openGraph.title).toBeDefined();
    expect(r1.body.meta.canonicalUrl).toContain('/versions/');

    // Create a book with no SEO and resolve by slug (fallback to version data if any)
    const book = await prisma.book.create({ data: { slug: `book-seo-resolve-${Date.now()}` } });
    const bv = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'V Title',
        author: 'V Author',
        description: 'V Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
      },
    });
    // Create categories: root -> sub, attach sub to version
    const rootSlug = `root-${Date.now()}`;
    const rootCat = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ type: 'genre', name: 'Root', slug: rootSlug })
      .expect(201);
    const sub = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        type: 'genre',
        name: 'Sub',
        slug: `sub-${Date.now()}`,
        parentId: rootCat.body.id as string,
      })
      .expect(201);
    await request(http())
      .post(`/versions/${bv.id}/categories`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ categoryId: sub.body.id as string })
      .expect(201);
    const r2 = await request(http())
      .get('/seo/resolve')
      .query({ type: 'book', id: book.slug })
      .expect(200);
    expect(typeof r2.body.meta.title).toBe('string');
    expect(r2.body.meta.canonicalUrl).toContain(`/books/${book.slug}`);
    expect(Array.isArray(r2.body.breadcrumbPath)).toBe(true);
    expect(r2.body.breadcrumbPath.length).toBeGreaterThanOrEqual(1);
    expect(r2.body.breadcrumbPath[0].slug).toBe(rootSlug);
  });
});
