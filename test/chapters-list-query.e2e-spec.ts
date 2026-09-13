import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';
import { PAGINATION_MAX_LIMIT } from '../src/shared/dto/pagination.dto';

/**
 * Валидация `page`/`limit` на списке глав (`LEGACY-178`, `LEGACY-176`).
 *
 * До 13.09.2026 оба маршрута списка глав — публичный и админский — читали
 * параметры сырыми `@Query('page')` / `@Query('limit')` и гнали через
 * `parseInt`. Ни DTO, ни `ValidationPipe` на пути не было: `?limit=100000`
 * уезжал в `take` Prisma как есть, `?limit=abc` давал `NaN`, `?limit=-5` —
 * отрицательный `take`.
 *
 * 🔴 Почему e2e, а не юнит: дефект жил в связке «глобальный пайп + сигнатура
 * обработчика». Юнит, вызывающий метод контроллера напрямую, пайпа не видит
 * и остаётся зелёным при возврате сырых `@Query` — тот же довод, что
 * в `categories-list-query.e2e-spec.ts`.
 *
 * ⚠️ Режим «все главы разом» проверяется здесь же и обязан остаться: он
 * сохранён решением владельца 13.09.2026, его ждёт админский экран глав
 * во фронте. Обязательная пагинация — ломающее изменение контракта, а не
 * ужесточение валидации.
 */
describe('Chapters list query validation (LEGACY-178) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
  let adminToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const adminEmail = `chapters-query-${Date.now()}@test.com`;
    process.env.ADMIN_EMAILS = adminEmail;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await createBookFixture(prisma, `chapters-query-${Date.now()}`);
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
        status: 'published',
      },
    });
    versionId = version.id;

    // Три главы: меньше страницы и больше одной — чтобы `limit=2` отличался
    // и от полного списка, и от пустого.
    await prisma.chapter.createMany({
      data: [1, 2, 3].map((number) => ({
        bookVersionId: versionId,
        number,
        title: `Chapter ${number}`,
        content: `Text ${number}`,
      })),
    });

    const reg = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password: 'password123' });
    adminToken = (reg.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('публичный GET /versions/:id/chapters', () => {
    it(`limit выше потолка ${PAGINATION_MAX_LIMIT} отклоняется с 400`, async () => {
      const res = await request(http())
        .get(`/versions/${versionId}/chapters`)
        .query({ page: 1, limit: 100000 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('limit');
    });

    it('нечисловой limit отклоняется с 400, а не превращается в NaN', async () => {
      await request(http())
        .get(`/versions/${versionId}/chapters`)
        .query({ page: 1, limit: 'abc' })
        .expect(400);
    });

    it('отрицательные page и limit отклоняются с 400', async () => {
      await request(http())
        .get(`/versions/${versionId}/chapters`)
        .query({ page: 1, limit: -5 })
        .expect(400);
      await request(http())
        .get(`/versions/${versionId}/chapters`)
        .query({ page: 0, limit: 10 })
        .expect(400);
    });

    it(`limit ровно ${PAGINATION_MAX_LIMIT} проходит — потолок включающий`, async () => {
      const res = await request(http())
        .get(`/versions/${versionId}/chapters`)
        .query({ page: 1, limit: PAGINATION_MAX_LIMIT });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('пагинация работает: limit=2 отдаёт две первые главы по номеру', async () => {
      const res = await request(http())
        .get(`/versions/${versionId}/chapters`)
        .query({ page: 1, limit: 2 })
        .expect(200);
      const body = res.body as Array<{ number: number }>;
      expect(body).toHaveLength(2);
      expect(body.map((c) => c.number)).toEqual([1, 2]);
    });

    // 🔴 Дыра, найденная ревью 13.09.2026: `listInternal` паджинирует по условию
    // `if (page && limit)`, поэтому одиночный `limit` проходил валидацию
    // с объявленным потолком и уходил в безлимитную ветку — анониму уезжали все
    // главы версии с полным `content` при HTTP 200.
    it('одиночный limit без page отвергается, а не уходит в безлимитную ветку', async () => {
      const res = await request(http()).get(`/versions/${versionId}/chapters`).query({ limit: 2 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('page');
    });

    it('одиночный page без limit отвергается, а не игнорируется молча', async () => {
      const res = await request(http()).get(`/versions/${versionId}/chapters`).query({ page: 2 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('limit');
    });

    it('без параметров отдаёт все главы — режим сохранён сознательно', async () => {
      const res = await request(http()).get(`/versions/${versionId}/chapters`).expect(200);
      expect(res.body as unknown[]).toHaveLength(3);
    });
  });

  describe('админский GET /admin/versions/:id/chapters', () => {
    it(`limit выше потолка ${PAGINATION_MAX_LIMIT} отклоняется с 400`, async () => {
      await request(http())
        .get(`/admin/versions/${versionId}/chapters`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, limit: 100000 })
        .expect(400);
    });

    it('без параметров отдаёт все главы', async () => {
      const res = await request(http())
        .get(`/admin/versions/${versionId}/chapters`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body as unknown[]).toHaveLength(3);
    });
  });
});
