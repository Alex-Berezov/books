import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';
import { PAGINATION_MAX_LIMIT } from '../src/shared/dto/pagination.dto';

/**
 * `LEGACY-298` (схлопнута `LEGACY-353`). `GET /categories` принимал `page`/`limit`
 * через `@Query('page', new DefaultValuePipe(1), ParseIntPipe)` — приведение типа
 * без верхней границы вовсе: `?limit=100000` проходило и уезжало в `take` Prisma
 * как есть. Соседние публичные списки того же класса (`/:lang/books`, `/:lang/tags`)
 * на DTO уже отвечают 400 на тот же мусор.
 *
 * 🔴 Почему e2e, а не юнит: дефект жил в связке «глобальный пайп + сигнатура
 * обработчика» — юнит, вызывающий метод контроллера напрямую, пайп не видит.
 */
describe('Categories list query validation (LEGACY-298/353) e2e', () => {
  let app: INestApplication;
  let adminToken: string;
  let genreSlug: string;
  let collectionSlug: string;

  const http = () => httpServerOf(app);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const adminEmail = `categories-query-${Date.now()}@test.com`;
    process.env.ADMIN_EMAILS = adminEmail;
    const reg = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password: 'password123' });
    adminToken = (reg.body as { accessToken: string }).accessToken;

    // Два термина разного `type` — иначе фильтр нечем проверить: список без
    // фикстур остаётся непустым и без фильтрации, а тест это не отличит.
    const stamp = Date.now();
    genreSlug = `catq-genre-${stamp}`;
    collectionSlug = `catq-collection-${stamp}`;
    await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'genre', name: genreSlug, slug: genreSlug, key: genreSlug })
      .expect(201);
    await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ type: 'collection', name: collectionSlug, slug: collectionSlug, key: collectionSlug })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('без параметров отдаёт первую страницу дефолтного размера', async () => {
    const res = await request(http()).get('/categories').expect(200);
    const body = res.body as { data: unknown[]; meta: { page: number; limit: number } };

    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.page).toBe(1);
    expect(body.meta.limit).toBe(20);
  });

  it.each(['?page=abc', '?page=', '?page=0', '?page=-1'])(
    'мусор в page отбивается кодом 400, а не приводится к дефолту молча: %s',
    async (query) => {
      await request(http()).get(`/categories${query}`).expect(400);
    },
  );

  it('limit выше потолка отбивается, ровно на потолке проходит', async () => {
    await request(http())
      .get(`/categories?limit=${PAGINATION_MAX_LIMIT + 1}`)
      .expect(400);

    const res = await request(http()).get(`/categories?limit=${PAGINATION_MAX_LIMIT}`).expect(200);
    expect((res.body as { meta: { limit: number } }).meta.limit).toBe(PAGINATION_MAX_LIMIT);
  });

  /**
   * Собирает `slug` со всех страниц `type=...` — фикстура попадает в базу
   * заведомого, но неизвестного размера (общая база воркера e2e), и порядок
   * `sortOrder, name` не гарантирует место на первой странице.
   */
  const collectSlugs = async (type: string): Promise<Set<string>> => {
    const slugs = new Set<string>();
    let page = 1;
    for (;;) {
      const res = await request(http())
        .get(`/categories?type=${type}&limit=${PAGINATION_MAX_LIMIT}&page=${page}`)
        .expect(200);
      const body = res.body as {
        data: Array<{ slug: string; type: string }>;
        meta: { totalPages: number };
      };
      body.data.forEach((c) => slugs.add(c.slug));
      if (page >= body.meta.totalPages || page > 20) break;
      page += 1;
    }
    return slugs;
  };

  it('type действительно фильтрует, а не только принимает значение', async () => {
    const genreSlugs = await collectSlugs('genre');
    const collectionSlugs = await collectSlugs('collection');

    expect(genreSlugs.has(genreSlug)).toBe(true);
    expect(genreSlugs.has(collectionSlug)).toBe(false);
    expect(collectionSlugs.has(collectionSlug)).toBe(true);
    expect(collectionSlugs.has(genreSlug)).toBe(false);
  });

  it('lang принимается вместе с type, ответ остаётся согласованным', async () => {
    const res = await request(http()).get('/categories?type=genre&lang=en').expect(200);
    const body = res.body as { data: Array<{ type: string }> };

    expect(body.data.every((c) => c.type === 'genre')).toBe(true);
  });

  it('неизвестное значение type отбивается 400, а не уходит в Prisma сырым', async () => {
    await request(http()).get('/categories?type=bogus').expect(400);
  });

  it('неизвестное значение lang отбивается 400, а не падает 500 из сырого SQL', async () => {
    await request(http()).get('/categories?lang=xx').expect(400);
  });

  it('неизвестный параметр не принимается молча', async () => {
    await request(http()).get('/categories?perPage=10').expect(400);
  });
});
