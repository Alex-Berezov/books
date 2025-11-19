/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * E2E test to verify ALL 8 SEO fields mentioned in BACKEND_SEO_FIELDS_NOT_SAVED.md
 * are properly saved and returned by the API.
 */
describe('SEO All Fields E2E (BACKEND_SEO_FIELDS_NOT_SAVED.md)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
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

    // Create test book version
    const book = await prisma.book.create({ data: { slug: `test-seo-fields-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Harry Potter',
        author: 'J.K. Rowling',
        description: 'A wizard story',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    // Login as admin
    const adminEmail = 'admin@example.com';
    const password = 'password123';
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
      throw new Error('Admin registration failed');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('should save and return ALL 8 SEO fields from BACKEND_SEO_FIELDS_NOT_SAVED.md', async () => {
    // This is the exact payload from the documentation
    const payload = {
      metaTitle: 'harry-potter',
      metaDescription: 'harry-potter',
      canonicalUrl: 'https://bibliaris.com/en/harry-potter',
      robots: 'index, follow',
      ogTitle: 'Harry Potter',
      ogDescription: 'Harry Potter',
      ogImageUrl: 'https://humoraf.ru/wp-content/themes/humoraf/img/pictures.jpg',
      twitterCard: 'summary',
    };

    // PUT request to create/update SEO
    const putResponse = await request(http())
      .put(`/versions/${versionId}/seo`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload)
      .expect(200);

    // Verify response contains ALL 8 fields
    expect(putResponse.body.id).toBeDefined();
    expect(putResponse.body.metaTitle).toBe('harry-potter');
    expect(putResponse.body.metaDescription).toBe('harry-potter');
    expect(putResponse.body.canonicalUrl).toBe('https://bibliaris.com/en/harry-potter');
    expect(putResponse.body.robots).toBe('index, follow');
    expect(putResponse.body.ogTitle).toBe('Harry Potter');
    expect(putResponse.body.ogDescription).toBe('Harry Potter');
    expect(putResponse.body.ogImageUrl).toBe(
      'https://humoraf.ru/wp-content/themes/humoraf/img/pictures.jpg',
    );
    expect(putResponse.body.twitterCard).toBe('summary');

    // Subsequent GET request to verify persistence
    const getResponse = await request(http()).get(`/versions/${versionId}/seo`).expect(200);

    // Verify ALL 8 fields are persisted in database
    expect(getResponse.body.metaTitle).toBe('harry-potter');
    expect(getResponse.body.metaDescription).toBe('harry-potter');
    expect(getResponse.body.canonicalUrl).toBe('https://bibliaris.com/en/harry-potter');
    expect(getResponse.body.robots).toBe('index, follow');
    expect(getResponse.body.ogTitle).toBe('Harry Potter');
    expect(getResponse.body.ogDescription).toBe('Harry Potter');
    expect(getResponse.body.ogImageUrl).toBe(
      'https://humoraf.ru/wp-content/themes/humoraf/img/pictures.jpg',
    );
    expect(getResponse.body.twitterCard).toBe('summary');
  });

  it('should include all SEO fields in GET /admin/versions/:id response', async () => {
    // First ensure SEO exists
    const payload = {
      metaTitle: 'Complete SEO',
      metaDescription: 'All fields test',
      canonicalUrl: 'https://example.com/test',
      robots: 'noindex, nofollow',
      ogTitle: 'OG Title Test',
      ogDescription: 'OG Description Test',
      ogImageUrl: 'https://example.com/og-image.jpg',
      twitterCard: 'summary_large_image',
    };

    await request(http())
      .put(`/versions/${versionId}/seo`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload)
      .expect(200);

    // Get version with populated SEO
    const response = await request(http())
      .get(`/admin/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // Verify version response includes full SEO object
    expect(response.body.seo).toBeDefined();
    expect(response.body.seo.metaTitle).toBe('Complete SEO');
    expect(response.body.seo.metaDescription).toBe('All fields test');
    expect(response.body.seo.canonicalUrl).toBe('https://example.com/test');
    expect(response.body.seo.robots).toBe('noindex, nofollow');
    expect(response.body.seo.ogTitle).toBe('OG Title Test');
    expect(response.body.seo.ogDescription).toBe('OG Description Test');
    expect(response.body.seo.ogImageUrl).toBe('https://example.com/og-image.jpg');
    expect(response.body.seo.twitterCard).toBe('summary_large_image');
  });
});
