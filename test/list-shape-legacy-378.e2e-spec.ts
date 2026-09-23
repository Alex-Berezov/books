import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';

/**
 * `LEGACY-378`: публичные списки отдают `{items, pagination}` — ту же форму, что и всё
 * за логином. Снаружи обёртки ровно два ключа: прежние `data`/`meta` и плоские
 * `total`/`hasNext` рядом с `items` краснят набор. Списки глав проверяются
 * в `chapters-list-query.e2e-spec.ts` вместе с настоящим `total`.
 */
describe('Public list shape e2e (LEGACY-378)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const expectListShape = (body: unknown, page: number, limit: number): void => {
    expect(Array.isArray(body)).toBe(false);
    expect(Object.keys(body as object).sort()).toEqual(['items', 'pagination']);
    const { items, pagination } = body as {
      items: unknown;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };
    expect(Array.isArray(items)).toBe(true);
    expect(pagination.page).toBe(page);
    expect(pagination.limit).toBe(limit);
    expect(typeof pagination.total).toBe('number');
    expect(pagination.totalPages).toBe(Math.ceil(pagination.total / limit));
  };

  it.each(['books', 'categories', 'tags', 'authors'])('GET /:lang/%s', async (route) => {
    const res = await request(httpServerOf(app)).get(`/en/${route}?page=1&limit=5`).expect(200);
    expectListShape(res.body, 1, 5);
  });

  it('GET /comments carries hasNext inside pagination', async () => {
    const res = await request(httpServerOf(app))
      .get('/comments')
      .query({ target: 'version', targetId: randomUUID(), page: 1, limit: 5 })
      .expect(200);
    expectListShape(res.body, 1, 5);
    expect((res.body as { pagination: { hasNext: unknown } }).pagination.hasNext).toBe(false);
  });
});
