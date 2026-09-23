import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PUBLIC_CATEGORIES_MAX_LIMIT } from '../src/modules/public/dto/public-categories-query.dto';

/**
 * LEGACY-056. Публичный `GET /:lang/categories` звал сервис как `list(1, 50, …)` —
 * `page` и `limit` были зашиты в вызов. Наружу отдавались первые 50 строк каждого
 * типа, а `meta.totalPages` при этом честно обещал шесть страниц, недостижимых ни
 * при каких параметрах: 121 термин из 271 не отдавался нигде и никак.
 *
 * Отсюда форма посадок. Проверяется не «параметр дошёл до сервиса», а
 * **достижимость строк**: обход страниц обязан выдать ровно `total` разных
 * терминов. Проверка «page=2 отличается от page=1» одна этого не ловит — её можно
 * удовлетворить, отдавая разные куски одной и той же полусотни.
 */
describe('Public categories pagination (LEGACY-056) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const marker = `pgn-${Date.now()}`;
  const SEEDED = 7;

  interface CategoryRow {
    id: string;
    slug: string;
  }

  interface ListResponse {
    items: CategoryRow[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Собственные термины: набор из сидов меняется, и посадка не должна от него зависеть.
    for (let i = 0; i < SEEDED; i += 1) {
      await prisma.category.create({
        data: {
          type: 'collection',
          name: `${marker}-${i}`,
          slug: `${marker}-${i}`,
          key: `${marker}-${i}`,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { slug: { startsWith: marker } } });
    await app.close();
  });

  const list = async (query: string): Promise<ListResponse> => {
    const res = await request(http()).get(`/en/categories${query}`).expect(200);
    return res.body as ListResponse;
  };

  it('serves a different set on the second page', async () => {
    const first = await list('?type=collection&page=1&limit=3');
    const second = await list('?type=collection&page=2&limit=3');

    expect(first.items.length).toBe(3);
    expect(second.items.length).toBeGreaterThan(0);

    const firstIds = first.items.map((row) => row.id);
    const secondIds = second.items.map((row) => row.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('makes every row reachable: walking the pages yields exactly total distinct rows', async () => {
    const limit = 3;
    const head = await list(`?type=collection&page=1&limit=${limit}`);
    const total = head.pagination.total;
    expect(total).toBeGreaterThanOrEqual(SEEDED);

    const seen = new Set<string>();
    const pages = Math.ceil(total / limit);
    for (let page = 1; page <= pages; page += 1) {
      const chunk = await list(`?type=collection&page=${page}&limit=${limit}`);
      for (const row of chunk.items) seen.add(row.id);
    }

    // Ровно total: меньше — строки недостижимы, больше — страницы пересекаются.
    expect(seen.size).toBe(total);
    expect(head.pagination.totalPages).toBe(pages);
  });

  it('LEGACY-377: refuses a limit above the ceiling with 400 instead of capping it silently', async () => {
    // Потолок в DTO, а не `Math.min` в контроллере: урезанная страница с кодом 200
    // выдавала запрос за исполненный.
    await request(http())
      .get(`/en/categories?type=collection&limit=${PUBLIC_CATEGORIES_MAX_LIMIT + 1}`)
      .expect(400);
    await request(http()).get('/en/categories?limit=100000').expect(400);

    const res = await list(`?type=collection&limit=${PUBLIC_CATEGORIES_MAX_LIMIT}`);
    expect(res.pagination.limit).toBe(PUBLIC_CATEGORIES_MAX_LIMIT);
  });

  it('keeps the default at 50 — five storefronts depend on it', async () => {
    const res = await list('?type=collection');
    expect(res.pagination.limit).toBe(50);
  });

  it('answers 400 on a junk type instead of failing with 500', async () => {
    await request(http()).get('/en/categories?type=garbage-value-xyz').expect(400);
  });

  it('answers 400 on a non-numeric limit instead of a silent default', async () => {
    await request(http()).get('/en/categories?limit=abc').expect(400);
  });

  it('refuses an unsupported search parameter instead of ignoring it', async () => {
    // Поиск по категориям не реализован. Молчаливое игнорирование выглядело как
    // работающий фильтр: `?type=genre&search=adventure` отдавал нефильтрованную
    // первую страницу. Честный ответ — 400.
    await request(http()).get('/en/categories?search=adventure').expect(400);
  });
});
