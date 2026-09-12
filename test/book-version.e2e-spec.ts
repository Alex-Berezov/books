/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

// Response shape helper for stronger typing in assertions
interface BookVersionResponse {
  id: string;
  bookId: string;
  language: string;
  title: string;
  author: string;
  description: string;
  coverImageUrl: string;
  type: string;
  isFree: boolean;
  referralUrl?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  seoId?: number | null;
}

describe('BookVersions e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bookId: string;
  let bookSlug: string;
  let adminToken: string;
  const createdBookSlugs: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    const slug = `book-${Date.now()}`;
    const bookWithRights = await createBookWithRights(prisma, slug);
    bookId = bookWithRights.book.id;
    bookSlug = slug;
    createdBookSlugs.push(slug);

    // ensure admin auth
    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }
  });

  afterAll(async () => {
    for (const slug of createdBookSlugs) {
      await cleanupBookWithRights(prisma, slug);
    }
    await app.close();
  });

  // Strongly typed helper to avoid unsafe any from Nest's getHttpServer()
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  it('create (draft) -> public not visible -> admin sees -> publish -> public visible -> unpublish -> hide -> delete', async () => {
    const createRes = await request(http())
      .post(`/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const created: BookVersionResponse = createRes.body as BookVersionResponse;
    const versionId = created.id;

    // LEGACY-267: умолчание схемы `@default(published)` было противоположно продуктовому
    // правилу; ответ создания — единственная посадка, которая заметит, если новый путь
    // создания версии перестанет ставить `status: 'draft'` явно и откатится на умолчание.
    expect(created.status).toBe('draft');

    // Public must not see draft
    const listDraftHidden = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(Array.isArray(listDraftHidden.body)).toBe(true);
    expect(listDraftHidden.body.length).toBe(0);
    await request(http()).get(`/versions/${versionId}`).expect(404);

    // Admin sees draft via admin route
    const adminList = await request(http())
      .get(`/admin/en/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(adminList.body.length).toBe(1);

    // Admin can get draft version by ID via admin endpoint
    const adminGetDraft = await request(http())
      .get(`/admin/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(adminGetDraft.body.id).toBe(versionId);
    expect(adminGetDraft.body.status).toBe('draft');
    expect(adminGetDraft.body.title).toBe('Title EN');
    expect(adminGetDraft.body.bookSlug).toBe(bookSlug); // Проверяем, что bookSlug возвращается

    // Publish -> public should see now
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listAfterPublish = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(listAfterPublish.body.length).toBe(1);
    await request(http()).get(`/versions/${versionId}`).expect(200);

    // Unpublish -> public should hide again
    await request(http())
      .patch(`/versions/${versionId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // `LEGACY-180`: снятие с публикации обнуляет лицензионный снимок и пишет о снятии
    // строку в журнал административных действий — одной транзакцией. Условие записи
    // (`status: 'published'` ИЛИ `publishedAt != null`) проверяет сама база, поэтому
    // юнит-спека на моке его подтвердить не может, а эта проверка — может.
    const afterUnpublish = await prisma.bookVersion.findUnique({ where: { id: versionId } });
    expect(afterUnpublish?.status).toBe('draft');
    expect(afterUnpublish?.publishedAt).toBeNull();
    expect(afterUnpublish?.rightsLicenseIds).toBeNull();
    expect(afterUnpublish?.rightsLicenseCoverageStatus).toBeNull();
    expect(afterUnpublish?.rightsLicenseCheckedAt).toBeNull();
    expect(afterUnpublish?.rightsLicenseUncoveredCountryCodes).toBeNull();

    const auditRows = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'BOOK_VERSION', targetId: versionId },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('VERSION_UNPUBLISHED');
    expect(auditRows[0].actorUserId).not.toBeNull();

    // Повторное снятие уже снятой версии строки не добавляет: снимать нечего,
    // и событие «равно изменению состояния» (инвариант модели `AdminAuditEvent`).
    await request(http())
      .patch(`/versions/${versionId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const auditRowsAfterRepeat = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'BOOK_VERSION', targetId: versionId },
    });
    expect(auditRowsAfterRepeat).toHaveLength(1);

    const listAfterUnpublish = await request(http()).get(`/books/${bookId}/versions`).expect(200);
    expect(listAfterUnpublish.body.length).toBe(0);
    await request(http()).get(`/versions/${versionId}`).expect(404);
    // Update still works via admin
    await request(http())
      .patch(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Updated' })
      .expect(200);
    await request(http())
      .delete(`/versions/${versionId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });

  /**
   * Наполнение версии — работа на несколько заходов, поэтому черновик заводится с тем, что уже
   * введено. Наружу пустая оболочка не уходит: публикацию закрывает блокер гейта
   * `VERSION_CONTENT_INCOMPLETE`, а у опубликованной версии заполненное поле не стирается.
   */
  it('creates a draft without description and cover, refuses to publish it, and protects a published one', async () => {
    const slug = `book-${Date.now()}-3`;
    const bookWithRights = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);

    const createRes = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const created: BookVersionResponse = createRes.body as BookVersionResponse;
    expect(created.description).toBe('');
    expect(created.coverImageUrl).toBe('');

    // Нестроковая обложка — отказ валидации, а не пятисотка из Prisma.
    await request(http())
      .patch(`/versions/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ coverImageUrl: 123 })
      .expect(400);

    // Пустая оболочка наружу не уходит.
    const blocked = await request(http())
      .patch(`/versions/${created.id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(JSON.stringify(blocked.body)).toContain('VERSION_CONTENT_INCOMPLETE');

    // Наполнили — публикуется.
    await request(http())
      .patch(`/versions/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'Desc', coverImageUrl: 'https://example.com/cover.jpg' })
      .expect(200);
    await request(http())
      .patch(`/versions/${created.id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // У опубликованной версии описание стереть нельзя, а править остальное — можно.
    await request(http())
      .patch(`/versions/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: '' })
      .expect(400);
    await request(http())
      .patch(`/versions/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Updated title' })
      .expect(200);

    await request(http())
      .delete(`/versions/${created.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });

  /**
   * LEGACY-267: посадка выше (`created.status === 'draft'`) проверяет только явную строку
   * `status: 'draft'` в `BookVersionService.create`, а не умолчание схемы — сервис никогда
   * не полагается на него. Эта проверка вставляет строку в обход сервиса, тем же клиентом
   * Prisma, что и приложение, не указывая `status` вовсе: только так виден настоящий эффект
   * `@default(draft)`/`ALTER COLUMN "status" SET DEFAULT 'draft'` на свежей базе e2e-прогона.
   */
  it('BookVersion.status defaults to draft at the schema level, not just in the service (LEGACY-267)', async () => {
    const slug = `book-${Date.now()}-default-status`;
    const bookWithRights = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);

    const rawVersion = await prisma.bookVersion.create({
      data: {
        bookId: bookWithRights.book.id,
        language: Language.fr,
        title: 'Schema default check',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
        // status intentionally omitted — this is exactly what LEGACY-267 guards against.
      },
    });

    expect(rawVersion.status).toBe('draft');
  });

  it('enforces uniqueness (bookId, language)', async () => {
    const slug = `book-${Date.now()}-2`;
    const bookWithRights = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);
    await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN 2',
        author: 'Author 2',
        description: 'Desc 2',
        coverImageUrl: 'https://example.com/cover2.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(400);
  });

  /**
   * `LEGACY-354`: `@@index([author, language, status])` упирается в потолок
   * размера ключа btree (~2704 байт) — без ограничения на входе слишком
   * длинное значение падало ошибкой драйвера (500), а не валидацией (400).
   */
  it('отбивает слишком длинного author валидацией (400), а не драйвером (500)', async () => {
    const slug = `book-${Date.now()}-4`;
    const bookWithRights = await createBookWithRights(prisma, slug);
    createdBookSlugs.push(slug);
    const tooLongAuthor = 'A'.repeat(501);

    await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: tooLongAuthor,
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(400);

    const created = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    const createdVersion: BookVersionResponse = created.body as BookVersionResponse;

    await request(http())
      .patch(`/versions/${createdVersion.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ author: tooLongAuthor })
      .expect(400);

    await request(http())
      .delete(`/versions/${createdVersion.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });
});
