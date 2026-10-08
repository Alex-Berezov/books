import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

describe('Books: Check Slug (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  // Helper to get typed HTTP server
  const http = () => app.getHttpServer() as unknown as Parameters<typeof request>[0];

  beforeAll(async () => {
    // Fixed admin email; the admin role is written by grantStaffRoles after register (LEGACY-443)
    const adminEmail = 'admin-book-slug@test.com';
    const adminPassword = 'password123';

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
    await grantStaffRoles(app, adminEmail);

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
                'version-slug-book',
                'version-slug-other',
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
                'version-slug-book',
                'version-slug-other',
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
      await createBookFixture(prisma, 'test-book-existing');

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
      const book = await createBookFixture(prisma, 'test-book-for-edit');

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
      const book1 = await createBookFixture(prisma, 'incremental-book');

      const book2 = await createBookFixture(prisma, 'incremental-book-2');

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

  /**
   * С `lang` ручка проверяет слаг языковой версии так, как разрешается публичный адрес
   * (`getOverview`): версия в языке пути, затем версия с этим слагом в любом языке, затем
   * `Book.slug`. Занят слаг другой версии того же языка, `Book.slug` другой книги и слаг версии
   * другой книги в любом языке - иначе живой адрес чужой книги молча уходит на эту. Свои слаги
   * (своя книга и её версии в других языках) ведут в ту же книгу и свободны.
   */
  describe('GET /books/check-slug?lang=… (слаг языковой версии)', () => {
    let bookId: string;
    let otherBookId: string;
    let ruVersionId: string;

    const versionData = (book: string, language: 'en' | 'es' | 'ru', slug: string | null) => ({
      bookId: book,
      language,
      slug,
      title: 't',
      author: 'a',
      description: 'd',
      coverImageUrl: 'https://example.com/c.jpg',
      type: 'text' as const,
      isFree: true,
    });

    beforeAll(async () => {
      bookId = (await createBookFixture(prisma, 'version-slug-book')).id;
      ruVersionId = (
        await prisma.bookVersion.create({ data: versionData(bookId, 'ru', 'version-slug-ru') })
      ).id;
      await prisma.bookVersion.create({ data: versionData(bookId, 'en', 'version-slug-en') });

      // Чужая книга: черновая версия es со своим слагом и версия en без слага, которая
      // живёт по адресу книги `version-slug-other`.
      otherBookId = (await createBookFixture(prisma, 'version-slug-other')).id;
      await prisma.bookVersion.create({
        data: versionData(otherBookId, 'es', 'version-slug-other-es'),
      });
      await prisma.bookVersion.create({ data: versionData(otherBookId, 'en', null) });
    });

    const check = (query: Record<string, string>) =>
      request(http())
        .get('/books/check-slug')
        .query(query)
        .set('Authorization', `Bearer ${adminToken}`);

    it('слаг другой версии того же языка занят, подсказка подбирается по тем же правилам', async () => {
      const response = await check({
        slug: 'version-slug-en',
        lang: 'en',
        excludeVersionId: ruVersionId,
      }).expect(200);

      expect(response.body).toEqual({
        exists: true,
        suggestedSlug: 'version-slug-en-2',
        existingBook: { id: bookId, slug: 'version-slug-en' },
      });
    });

    it('своя версия исключается через excludeVersionId', async () => {
      const response = await check({
        slug: 'version-slug-ru',
        lang: 'ru',
        excludeVersionId: ruVersionId,
      }).expect(200);

      expect(response.body).toEqual({ exists: false });
    });

    it('слаг своей версии в другом языке и свой Book.slug свободны', async () => {
      const ownOtherLanguage = await check({
        slug: 'version-slug-en',
        lang: 'ru',
        excludeVersionId: ruVersionId,
      }).expect(200);
      expect(ownOtherLanguage.body).toEqual({ exists: false });

      // Форма создания версии знает только свою книгу.
      const ownBookSlug = await check({
        slug: 'version-slug-book',
        lang: 'es',
        excludeId: bookId,
      }).expect(200);
      expect(ownBookSlug.body).toEqual({ exists: false });
    });

    it('Book.slug другой книги занят: адрес её версии без слага ушёл бы на эту книгу', async () => {
      const response = await check({
        slug: 'version-slug-other',
        lang: 'ru',
        excludeVersionId: ruVersionId,
      }).expect(200);

      expect(response.body).toMatchObject({
        exists: true,
        existingBook: { id: otherBookId, slug: 'version-slug-other' },
      });
    });

    it('слаг черновой версии другой книги в другом языке занят', async () => {
      const response = await check({
        slug: 'version-slug-other-es',
        lang: 'ru',
        excludeId: bookId,
      }).expect(200);

      expect(response.body).toMatchObject({
        exists: true,
        existingBook: { id: otherBookId, slug: 'version-slug-other-es' },
      });
    });

    it('без своей книги занято любое совпадение', async () => {
      const response = await check({ slug: 'version-slug-ru', lang: 'en' }).expect(200);

      expect((response.body as { exists: boolean }).exists).toBe(true);
    });

    it('слаг, не занятый нигде, свободен', async () => {
      const response = await check({ slug: 'version-slug-free', lang: 'ru' }).expect(200);

      expect(response.body).toEqual({ exists: false });
    });

    it('excludeVersionId без lang — 400', async () => {
      await check({ slug: 'version-slug-ru', excludeVersionId: ruVersionId }).expect(400);
    });

    it('неизвестный язык — 400', async () => {
      await check({ slug: 'version-slug-ru', lang: 'xx' }).expect(400);
    });
  });
});
