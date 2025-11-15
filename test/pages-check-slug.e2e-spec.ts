/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import * as request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Pages: Check Slug (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  beforeAll(async () => {
    // Use fixed admin email - must be set BEFORE module creation for ConfigService
    const adminEmail = 'admin-page-slug@test.com';
    const adminPassword = 'password123';
    process.env.ADMIN_EMAILS = adminEmail;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    await app.init();

    // Register or login admin user
    const regRes = await request(app.getHttpServer()).post('/auth/register').send({
      email: adminEmail,
      password: adminPassword,
    });

    if (regRes.status === 201) {
      adminToken = regRes.body.accessToken;
    } else if (regRes.status === 409) {
      // User already exists, login instead
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({
        email: adminEmail,
        password: adminPassword,
      });
      adminToken = loginRes.body.accessToken;
    } else {
      throw new Error(`Unexpected admin register status: ${regRes.status}`);
    }

    // Cleanup any leftover test data from previous runs
    await prisma.page.deleteMany({
      where: {
        OR: [
          { slug: { in: ['test-slug-unique', 'test-slug-existing', 'multi-lang-slug'] } },
          { slug: { startsWith: 'incremental-test' } },
        ],
      },
    });
  });

  afterAll(async () => {
    // Cleanup: remove test pages
    await prisma.page.deleteMany({
      where: {
        OR: [
          { slug: { in: ['test-slug-unique', 'test-slug-existing', 'multi-lang-slug'] } },
          { slug: { startsWith: 'incremental-test' } },
        ],
      },
    });
    await app.close();
  });

  describe('GET /admin/pages/check-slug', () => {
    it('should return exists: false for unique slug in given language', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'test-slug-unique', lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({
        exists: false,
      });
    });

    it('should return exists: true and suggest alternative for taken slug', async () => {
      // Create a page with slug
      await prisma.page.create({
        data: {
          slug: 'test-slug-existing',
          title: 'Existing Test Page',
          type: 'generic',
          content: 'Test content',
          language: 'en',
          status: 'published',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'test-slug-existing', lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        exists: true,
        suggestedSlug: 'test-slug-existing-2',
        existingPage: {
          id: expect.any(String),
          title: 'Existing Test Page',
          status: 'published',
        },
      });
    });

    it('should exclude current page when excludeId provided', async () => {
      // Create a page
      const page = await prisma.page.create({
        data: {
          slug: 'test-slug-for-edit',
          title: 'Page for Edit Test',
          type: 'generic',
          content: 'Test content',
          language: 'en',
          status: 'draft',
        },
      });

      // Check same slug with excludeId - should be available
      const response = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'test-slug-for-edit', excludeId: page.id, lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({
        exists: false,
      });

      // Cleanup
      await prisma.page.delete({ where: { id: page.id } });
    });

    it('should return 400 for invalid slug format', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'Invalid Page Slug!', lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      // ValidationPipe returns the custom message from @Matches decorator
      expect(JSON.stringify(response.body.message)).toContain('Lowercase');
    });

    it('should return 401 without auth token', async () => {
      await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'test-slug', lang: 'en' })
        .expect(401);
    });

    it('should check slug uniqueness per language', async () => {
      // Create page with same slug but different language
      const pageEn = await prisma.page.create({
        data: {
          slug: 'multi-lang-slug',
          title: 'English Page',
          type: 'generic',
          content: 'EN content',
          language: 'en',
          status: 'published',
        },
      });

      // Check in English - should be taken
      const responseEn = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'multi-lang-slug', lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(responseEn.body.exists).toBe(true);

      // Check in Spanish - should be available
      const responseEs = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'multi-lang-slug', lang: 'es' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(responseEs.body.exists).toBe(false);

      // Cleanup
      await prisma.page.delete({ where: { id: pageEn.id } });
    });

    it('should suggest incremental suffixes when multiple exist', async () => {
      // Create pages with suffixes
      const page1 = await prisma.page.create({
        data: {
          slug: 'incremental-test',
          title: 'Test 1',
          type: 'generic',
          content: 'Content',
          language: 'en',
          status: 'published',
        },
      });

      const page2 = await prisma.page.create({
        data: {
          slug: 'incremental-test-2',
          title: 'Test 2',
          type: 'generic',
          content: 'Content',
          language: 'en',
          status: 'published',
        },
      });

      // Check - should suggest -2
      const response = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'incremental-test', lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.suggestedSlug).toBe('incremental-test-3');

      // Now check -2
      const response2 = await request(app.getHttpServer())
        .get('/admin/pages/check-slug')
        .query({ slug: 'incremental-test-2', lang: 'en' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response2.body.suggestedSlug).toBe('incremental-test-2-2');

      // Cleanup
      await prisma.page.deleteMany({
        where: {
          id: {
            in: [page1.id, page2.id],
          },
        },
      });
    });
  });
});
