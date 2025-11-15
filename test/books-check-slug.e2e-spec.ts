import * as request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Books: Check Slug (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  // Helper to get typed HTTP server
  const http = () => app.getHttpServer() as unknown as Parameters<typeof request>[0];

  beforeAll(async () => {
    // Use fixed admin email - must be set BEFORE module creation for ConfigService
    const adminEmail = 'admin-book-slug@test.com';
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
    const regRes = await request(http()).post('/auth/register').send({
      email: adminEmail,
      password: adminPassword,
    });

    if (regRes.status === 201) {
      adminToken = (regRes.body as { accessToken: string }).accessToken;
    } else if (regRes.status === 409) {
      // User already exists, login instead
      const loginRes = await request(http()).post('/auth/login').send({
        email: adminEmail,
        password: adminPassword,
      });
      adminToken = (loginRes.body as { accessToken: string }).accessToken;
    } else {
      throw new Error(`Unexpected admin register status: ${regRes.status}`);
    }

    // Cleanup any leftover test data from previous runs
    await prisma.book.deleteMany({
      where: {
        OR: [
          {
            slug: {
              in: [
                'test-book-unique',
                'test-book-existing',
                'test-book-for-edit',
                'multi-book-slug',
              ],
            },
          },
          { slug: { startsWith: 'incremental-book' } },
        ],
      },
    });
  });

  afterAll(async () => {
    // Cleanup: remove test books
    await prisma.book.deleteMany({
      where: {
        OR: [
          {
            slug: {
              in: [
                'test-book-unique',
                'test-book-existing',
                'test-book-for-edit',
                'multi-book-slug',
              ],
            },
          },
          { slug: { startsWith: 'incremental-book' } },
        ],
      },
    });
    await app.close();
  });

  describe('GET /books/check-slug', () => {
    it('should return exists: false for unique slug', async () => {
      const response = await request(http())
        .get('/books/check-slug')
        .query({ slug: 'test-book-unique' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({
        exists: false,
      });
    });

    it('should return exists: true and suggest alternative for taken slug', async () => {
      // Create a book with slug
      await prisma.book.create({
        data: {
          slug: 'test-book-existing',
        },
      });

      const response = await request(http())
        .get('/books/check-slug')
        .query({ slug: 'test-book-existing' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toMatchObject({
        exists: true,
        suggestedSlug: 'test-book-existing-2',
        existingBook: {
          id: expect.any(String) as string,
          slug: 'test-book-existing',
        },
      });
    });

    it('should exclude current book when excludeId provided', async () => {
      // Create a book
      const book = await prisma.book.create({
        data: {
          slug: 'test-book-for-edit',
        },
      });

      // Check same slug with excludeId - should be available
      const response = await request(http())
        .get('/books/check-slug')
        .query({ slug: 'test-book-for-edit', excludeId: book.id })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({
        exists: false,
      });

      // Cleanup
      await prisma.book.delete({ where: { id: book.id } });
    });

    it('should return 400 for invalid slug format', async () => {
      const response = await request(http())
        .get('/books/check-slug')
        .query({ slug: 'Invalid Book Slug!' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      // ValidationPipe returns the custom message from @Matches decorator
      expect(JSON.stringify((response.body as { message: unknown }).message)).toContain(
        'Lowercase',
      );
    });

    it('should return 401 without auth token', async () => {
      await request(http()).get('/books/check-slug').query({ slug: 'test-book' }).expect(401);
    });

    it('should suggest incremental suffixes when multiple exist', async () => {
      // Create books with suffixes
      const book1 = await prisma.book.create({
        data: {
          slug: 'incremental-book',
        },
      });

      const book2 = await prisma.book.create({
        data: {
          slug: 'incremental-book-2',
        },
      });

      // Check - should suggest -3
      const response = await request(http())
        .get('/books/check-slug')
        .query({ slug: 'incremental-book' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((response.body as { suggestedSlug: string }).suggestedSlug).toBe('incremental-book-3');

      // Now check -2
      const response2 = await request(http())
        .get('/books/check-slug')
        .query({ slug: 'incremental-book-2' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect((response2.body as { suggestedSlug: string }).suggestedSlug).toBe(
        'incremental-book-2-2',
      );

      // Cleanup
      await prisma.book.deleteMany({
        where: {
          id: {
            in: [book1.id, book2.id],
          },
        },
      });
    });
  });
});
