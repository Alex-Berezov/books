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

describe('Tags e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let versionId: string;
  let tagId: string;

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
    const book = await createBookFixture(prisma, `book-tag-${Date.now()}`);
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

  it('CRUD tag (admin only) and attach/detach to version', async () => {
    // create tag
    const createRes = await request(http())
      .post('/tags')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        name: 'Motivation E2E',
        slug: `motivation-e2e-${Date.now()}`,
        key: `motivation-e2e-${Date.now()}`,
      })
      .expect(201);
    tagId = createRes.body.id as string;

    // list
    await request(http()).get('/tags?page=1&limit=1').expect(200);

    // update
    await request(http())
      .patch(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Motivation Updated' })
      .expect(200);

    // attach
    await request(http())
      .post(`/versions/${versionId}/tags`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ tagId })
      .expect(201);

    // duplicate attach is idempotent
    await request(http())
      .post(`/versions/${versionId}/tags`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ tagId })
      .expect(201);

    // get books by tag slug
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    await request(http())
      .get(`/en/tags/${tag?.slug as string}/books`)
      .expect(200);

    // detach
    await request(http())
      .delete(`/versions/${versionId}/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    // delete tag
    await request(http())
      .delete(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });
  /**
   * 🔴 `LEGACY-363`. `@IsOptional()` пропускал `null` наравне с `undefined`, а
   * `ValidationPipe` объявленное поле со значением `null` не вырезает: `whitelist`
   * снимает только неописанные поля. Дальше `null` проходил строгое
   * `dto.X !== undefined` в сервисе, уходил в `data` и ронял Prisma на
   * `NOT NULL`-колонке — клиент получал 500, а в `update` откатывалась вся
   * транзакция термина: базовая строка и до пяти строк `SlugRedirect`.
   *
   * Решение арбитра 13.09.2026: на `NOT NULL`-колонке `null` — не «поле не задано»,
   * а ошибка клиента, и ответ на неё 400. Проверяются все четыре пути сущности:
   * `create` записью не покрывался, но рисунок там тот же, и переводы — тоже
   * (`LEGACY-131` запрещает чинить соседние пути порознь).
   *
   * Оснастка общая с категорией (`test/helpers/taxonomy-null-cases.ts`): у двух терминов
   * совпадают поля, колонки под ними и рисунок ручек, а третья копия этих же строк
   * внутри своего `describe` была бы не найдена автором четвёртого термина.
   */
  describe('явный null в опциональном поле на NOT NULL-колонке (LEGACY-363)', () => {
    const tag = taxonomyFixture(http, () => adminAccess, 'tags');

    it.each(TERM_NULL_CASES)(
      'POST /tags отвечает 400 на %s: null, а не 500',
      async (_field, body) => {
        const mark = uniqueMark('null-case');
        const res = await request(http())
          .post('/tags')
          .set('Authorization', `Bearer ${adminAccess}`)
          .send({ name: 'Null Case', slug: mark, key: mark, ...body });

        expect(res.status).toBe(400);
      },
    );

    it.each(TERM_NULL_CASES)(
      'PATCH /tags/:id отвечает 400 на %s: null, а не 500',
      async (_field, body) => {
        const id = await tag.create('null-patch');

        const res = await request(http())
          .patch(`/tags/${id}`)
          .set('Authorization', `Bearer ${adminAccess}`)
          .send(body);

        expect(res.status).toBe(400);

        await tag.drop(id);
      },
    );

    it.each(TRANSLATION_NULL_CASES)(
      'PATCH /tags/:id/translations/:language отвечает 400 на %s: null',
      async (_field, body) => {
        const id = await tag.create('null-tr');
        await tag.addTranslation(id);

        const res = await request(http())
          .patch(`/tags/${id}/translations/es`)
          .set('Authorization', `Bearer ${adminAccess}`)
          .send(body);

        expect(res.status).toBe(400);

        await tag.drop(id);
      },
    );

    it('перевод с нормальным name по-прежнему обновляется', async () => {
      const id = await tag.create('ok-tr');
      await tag.addTranslation(id);

      const res = await request(http())
        .patch(`/tags/${id}/translations/es`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ name: 'Traduccion Nueva' })
        .expect(200);

      expect(res.body.name).toBe('Traduccion Nueva');

      await tag.drop(id);
    });

    it('PATCH без поля по-прежнему проходит и поле не трогает', async () => {
      const id = await tag.create('untouched', { isVisible: false });

      const res = await request(http())
        .patch(`/tags/${id}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .send({ name: 'Untouched Renamed' })
        .expect(200);

      expect(res.body.isVisible).toBe(false);

      await tag.drop(id);
    });
  });
});
