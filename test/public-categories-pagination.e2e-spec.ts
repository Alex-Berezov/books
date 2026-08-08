import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

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
    data: CategoryRow[];
    meta: { page: number; limit: number; total: number; totalPages: number };
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

    expect(first.data.length).toBe(3);
    expect(second.data.length).toBeGreaterThan(0);

    const firstIds = first.data.map((row) => row.id);
    const secondIds = second.data.map((row) => row.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('makes every row reachable: walking the pages yields exactly total distinct rows', async () => {
    const limit = 3;
    const head = await list(`?type=collection&page=1&limit=${limit}`);
    const total = head.meta.total;
    expect(total).toBeGreaterThanOrEqual(SEEDED);

    const seen = new Set<string>();
    const pages = Math.ceil(total / limit);
    for (let page = 1; page <= pages; page += 1) {
      const chunk = await list(`?type=collection&page=${page}&limit=${limit}`);
      for (const row of chunk.data) seen.add(row.id);
    }

    // Ровно total: меньше — строки недостижимы, больше — страницы пересекаются.
    expect(seen.size).toBe(total);
    expect(head.meta.totalPages).toBe(pages);
  });

  it('caps the limit out loud: meta reports the applied value, not the requested one', async () => {
    const res = await list('?type=collection&limit=1000');

    // Молчаливое урезание — тот же дефект, что чиним: потребитель поделил бы
    // total на запрошенный limit и получил неверное число страниц.
    expect(res.meta.limit).toBe(200);
    expect(res.data.length).toBeLessThanOrEqual(200);
  });

  it('keeps the default at 50 — five storefronts depend on it', async () => {
    const res = await list('?type=collection');
    expect(res.meta.limit).toBe(50);
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
