import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';
import { PAGINATION_MAX_LIMIT } from '../src/shared/dto/pagination.dto';

/**
 * `LEGACY-298`. `GET /:lang/books` и `GET /:lang/tags` принимали `page`/`limit`
 * голым `@Query('page') page?: number` и оборачивали их идиомой
 * `page ? Number(page) : N`. Глобальный `ValidationPipe` приводит примитивный
 * query-параметр через `+value`, поэтому `?page=abc` давал `NaN`, а `?page=` — `0`;
 * оба falsy, и идиома молча подставляла дефолт вместо отказа — соседние маршруты
 * того же контроллера на DTO уже отвечали 400 на тот же мусор.
 *
 * 🔴 Почему e2e, а не юнит: дефект жил в связке «глобальный пайп + сигнатура
 * обработчика» — юнит, вызывающий метод контроллера напрямую, пайп не видит.
 */
describe('Public books/tags query validation (LEGACY-298) e2e', () => {
  let app: INestApplication;

  const http = () => httpServerOf(app);

  beforeAll(async () => {
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

  describe('GET /:lang/books', () => {
    it('без параметров отдаёт первую страницу дефолтного размера', async () => {
      const res = await request(http()).get('/en/books').expect(200);
      const body = res.body as { data: unknown[]; meta: { page: number; limit: number } };

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(10);
    });

    it.each(['?page=abc', '?page=', '?page=0', '?page=-1'])(
      'мусор в page отбивается кодом 400, а не отдаёт первую страницу молча: %s',
      async (query) => {
        await request(http()).get(`/en/books${query}`).expect(400);
      },
    );

    it('limit выше потолка отбивается, ровно на потолке проходит', async () => {
      await request(http())
        .get(`/en/books?limit=${PAGINATION_MAX_LIMIT + 1}`)
        .expect(400);

      const res = await request(http()).get(`/en/books?limit=${PAGINATION_MAX_LIMIT}`).expect(200);
      expect((res.body as { meta: { limit: number } }).meta.limit).toBe(PAGINATION_MAX_LIMIT);
    });

    it('неизвестный параметр не принимается молча', async () => {
      await request(http()).get('/en/books?perPage=10').expect(400);
    });
  });

  describe('GET /:lang/tags', () => {
    it('без параметров отдаёт первую страницу дефолтного размера', async () => {
      const res = await request(http()).get('/en/tags').expect(200);
      const body = res.body as { data: unknown[]; meta: { page: number; limit: number } };

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(50);
    });

    it.each(['?page=abc', '?page=', '?page=0', '?page=-1'])(
      'мусор в page отбивается кодом 400, а не отдаёт первую страницу молча: %s',
      async (query) => {
        await request(http()).get(`/en/tags${query}`).expect(400);
      },
    );

    it('limit выше потолка отбивается, ровно на потолке проходит', async () => {
      await request(http())
        .get(`/en/tags?limit=${PAGINATION_MAX_LIMIT + 1}`)
        .expect(400);

      const res = await request(http()).get(`/en/tags?limit=${PAGINATION_MAX_LIMIT}`).expect(200);
      expect((res.body as { meta: { limit: number } }).meta.limit).toBe(PAGINATION_MAX_LIMIT);
    });

    it('неизвестный параметр не принимается молча', async () => {
      await request(http()).get('/en/tags?perPage=10').expect(400);
    });
  });
});
