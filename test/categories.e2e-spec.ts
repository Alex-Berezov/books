/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';
import {
  TERM_NULL_CASES,
  TRANSLATION_NULL_CASES,
  taxonomyFixture,
  uniqueMark,
} from './helpers/taxonomy-null-cases';

describe('Categories e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let versionId: string;
  let categoryId: string;

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

    // create book + version
    const book = await createBookFixture(prisma, `book-cat-${Date.now()}`);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    // login admin
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('CRUD category (admin only) and attach/detach to version', async () => {
    // create category
    const createRes = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        type: 'genre',
        name: 'Fantasy E2E',
        slug: `fantasy-e2e-${Date.now()}`,
        key: `fantasy-e2e-${Date.now()}`,
      })
      .expect(201);
    categoryId = createRes.body.id as string;

    // list (безъязыкий `GET /categories` снят пачкой `W6`, `LEGACY-387`; список за логином теперь `/admin/categories`)
    await request(http())
      .get('/admin/categories?page=1&limit=1')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // update
    await request(http())
      .patch(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Fantasy Updated' })
      .expect(200);

    // attach
    await request(http())
      .post(`/versions/${versionId}/categories`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ categoryId })
      .expect(201);

    // duplicate attach is idempotent
    await request(http())
      .post(`/versions/${versionId}/categories`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ categoryId })
      .expect(201);

    // get books by category slug
    const cat = await prisma.category.findUnique({ where: { id: categoryId } });
    await request(http()).get(`/en/categories/${cat?.slug}/books`).expect(200);

    // create child category
    const childRes = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        type: 'genre',
        name: 'Dark Fantasy',
        slug: `dark-fantasy-e2e-${Date.now()}`,
        key: `dark-fantasy-e2e-${Date.now()}`,
        parentId: categoryId,
      })
      .expect(201);
    const childId = childRes.body.id as string;

    // get children
    await request(http()).get(`/categories/${categoryId}/children`).expect(200);

    // get tree
    await request(http()).get('/categories/tree').expect(200);

    // try delete parent (should fail)
    await request(http())
      .delete(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);

    // move child to root
    await request(http())
      .patch(`/categories/${childId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ parentId: null })
      .expect(200);

    // detach
    await request(http())
      .delete(`/versions/${versionId}/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    // delete category and child
    await request(http())
      .delete(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await request(http())
      .delete(`/categories/${childId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });
  /**
   * 🔴 `LEGACY-363`, вторая сущность. Правило `LEGACY-131` запрещает чинить два
   * соседних пути порознь: у категории тот же вход, тот же строгий спред в сервисе
   * и те же `NOT NULL`-колонки, что у тега — включая переводы. Оснастка общая
   * (`test/helpers/taxonomy-null-cases.ts`), различаются только адрес и обязательный `type`.
   *
   * Отдельным кейсом закреплено, что `parentId: null` остался законным: колонка
   * `Category.parentId` nullable, и `null` там значит «отвязать от родителя» —
   * `category.service.ts` разбирает это состояние явно. Граница решения арбитра
   * проведена именно так: `null` отвергается только на `NOT NULL`-колонке.
   */
  describe('явный null в опциональном поле на NOT NULL-колонке (LEGACY-363)', () => {
    const category = taxonomyFixture(http, () => adminAccess, 'categories', { type: 'genre' });

    /** У категории на `NOT NULL`-колонке лежит ещё и `type`. */
    const categoryNullCases = [...TERM_NULL_CASES, ['type', { type: null }]] as const;

    it.each(categoryNullCases)(
      'POST /categories отвечает 400 на %s: null, а не 500',
      async (_field, body) => {
        const mark = uniqueMark('cat-null');
        const res = await request(http())
          .post('/categories')
          .set('Authorization', `Bearer ${adminAccess}`)
          .send({ type: 'genre', name: 'Null Case', slug: mark, key: mark, ...body });

        expect(res.status).toBe(400);
      },
    );

    it.each(categoryNullCases)(
      'PATCH /categories/:id отвечает 400 на %s: null, а не 500',
      async (_field, body) => {
        const id = await category.create('cat-null-patch');

        const res = await request(http())
          .patch(`/categories/${id}`)
          .set('Authorization', `Bearer ${adminAccess}`)
          .send(body);

        expect(res.status).toBe(400);

        await category.drop(id);
      },
    );

    it.each(TRANSLATION_NULL_CASES)(
      'PATCH /categories/:id/translations/:language отвечает 400 на %s: null',
      async (_field, body) => {
        const id = await category.create('cat-null-tr');
        await category.addTranslation(id);

        const res = await request(http())
          .patch(`/categories/${id}/translations/es`)
          .set('Authorization', `Bearer ${adminAccess}`)
          .send(body);

        expect(res.status).toBe(400);

        await category.drop(id);
      },
    );

    it('parentId: null по-прежнему принимается — колонка nullable, это отвязка', async () => {
      const parentId = await category.create('cat-null-parent');
      const childId = await category.create('cat-null-child');

      await request(http())
        .patch(`/categories/${childId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ parentId })
        .expect(200);

      const res = await request(http())
        .patch(`/categories/${childId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ parentId: null })
        .expect(200);

      expect(res.body.parentId).toBeNull();

      for (const id of [childId, parentId]) {
        await category.drop(id);
      }
    });
  });
  /**
   * `LEGACY-387`: админский список терминов. Заведён, чтобы пикеры админки не читали
   * публичный `GET /:lang/categories` — тот под `PublicCacheInterceptor`, и заведённая
   * категория не появлялась бы в форме до часа (решение арбитра 22.09.2026).
   */
  describe('GET /admin/categories', () => {
    const category = taxonomyFixture(http, () => adminAccess, 'categories', { type: 'genre' });

    it('без токена отвечает 401, а не отдаёт список', async () => {
      await request(http()).get('/admin/categories?page=1&limit=1').expect(401);
    });

    it('с токеном админа отдаёт форму `{items, pagination}`, а не публичную `{data, meta}`', async () => {
      const id = await category.create('admin-list');

      const res = await request(http())
        .get('/admin/categories?page=1&limit=100')
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);

      // Форма за логином одна на все такие ручки (`LEGACY-177`); публичная `{data, meta}`
      // осталась только на публичных адресах. Обе половины проверяются явно: подмена
      // формы обязана ронять набор, а не молча отдавать пустоту потребителю.
      const body = res.body as {
        items: Array<{ id: string }>;
        pagination: { page: number; limit: number; total: number; totalPages: number };
      };
      expect(Array.isArray(body.items)).toBe(true);
      expect(res.body).not.toHaveProperty('data');
      expect(res.body).not.toHaveProperty('meta');
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(100);
      expect(typeof body.pagination.total).toBe('number');
      expect(typeof body.pagination.totalPages).toBe('number');
      expect(body.items.map((row) => row.id)).toContain(id);

      await category.drop(id);
    });

    it('`type` фильтрует выдачу', async () => {
      const id = await category.create('admin-genre');

      const res = await request(http())
        .get('/admin/categories?page=1&limit=100&type=category')
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);

      const ids = (res.body as { items: Array<{ id: string }> }).items.map((row) => row.id);
      expect(ids).not.toContain(id);

      await category.drop(id);
    });
  });
});
