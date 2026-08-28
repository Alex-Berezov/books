import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { collectRoutes, HttpVerb } from '../src/common/testing/controller-decorators';
import { httpServerOf } from './http-server';

/**
 * `LEGACY-234`. У закрытого маршрута e2e проверяли только «с токеном
 * работает». Первая половина без второй не отличает закрытый маршрут
 * от открытого: перенос `@UseGuards(JwtAuthGuard, RolesGuard)` с класса
 * на методы с пропуском одного `@Get()` открывает весь контур анониму,
 * и не краснеет ничто — `roles-guard-wiring.spec.ts` смотрит связку
 * `@Roles` с `RolesGuard` (у открывшегося обработчика не останется ни
 * того ни другого, и в его выборку он не попадёт), `route-order.spec.ts`
 * смотрит порядок путей, а все наборы e2e ходят с токеном.
 *
 * 🔴 Поэтому список закрытых маршрутов здесь **не выводится из гвардов**.
 * Выведенный список сжимался бы вместе с ними: снял гвард — маршрут выпал
 * из проверки — сторож зелёный. Зафиксирован обратный, публичный список,
 * и всё, чего в нём нет, обязано отвечать `401` без токена.
 *
 * 🔴 Дописать строку в `PUBLIC_ROUTES`, чтобы погасить красное, тоже нельзя:
 * отдельный кейс требует, чтобы у каждого маршрута списка **в коде**
 * не было `JwtAuthGuard`. Иначе открыть закрытый маршрут можно было бы
 * одной строкой в тесте — ровно тем движением, ради которого он написан.
 *
 * Публичным считается маршрут, у которого по замыслу нет `JwtAuthGuard`.
 * Часть из них закрыта другим механизмом (`/metrics` — `MetricsAccessGuard`,
 * `/rights/agent/*` — `RightsAgentTokenGuard`); эта проверка про них
 * ничего не утверждает.
 */

const PUBLIC_ROUTES: ReadonlyArray<readonly [HttpVerb, string]> = [
  ['get', '/'],
  ['get', '/:lang/authors'],
  ['get', '/:lang/authors/:slug'],
  ['get', '/:lang/authors/:slug/books/cards'],
  ['get', '/:lang/authors/letters'],
  ['get', '/:lang/books'],
  ['get', '/:lang/books/:slug/overview'],
  ['get', '/:lang/books/:slug/reader-bootstrap'],
  ['get', '/:lang/books/:slug/related'],
  ['get', '/:lang/books/cards'],
  ['get', '/:lang/categories'],
  ['get', '/:lang/categories/:slug/books'],
  ['get', '/:lang/categories/:slug/books/cards'],
  ['get', '/:lang/pages/:slug'],
  ['get', '/:lang/pages/by-key/:systemKey'],
  ['get', '/:lang/seo/resolve'],
  ['get', '/:lang/slug-redirect'],
  ['get', '/:lang/tags'],
  ['get', '/:lang/tags/:slug/books'],
  ['get', '/:lang/tags/:slug/books/cards'],
  ['get', '/audio-chapters/:id'],
  ['get', '/books/:bookId/versions'],
  ['get', '/books/:id'],
  ['get', '/books/:slug/overview'],
  ['get', '/books/slug/:slug'],
  ['get', '/categories'],
  ['get', '/categories/:id/ancestors'],
  ['get', '/categories/:id/children'],
  ['get', '/categories/:slug/books'],
  ['get', '/categories/tree'],
  ['get', '/chapters/:id'],
  ['get', '/comments'],
  ['get', '/comments/:id'],
  ['get', '/health'],
  ['get', '/health/liveness'],
  ['get', '/health/readiness'],
  ['get', '/likes/count'],
  ['get', '/metrics'],
  ['get', '/pages/:slug'],
  ['get', '/rights/agent/manifest'],
  ['get', '/rights/agent/report-schema'],
  ['get', '/rights/agent/report-schema/:version'],
  ['get', '/robots.txt'],
  ['get', '/seo/resolve'],
  ['get', '/sitemap-:lang.xml'],
  ['get', '/sitemap.xml'],
  ['get', '/tags'],
  ['get', '/tags/:slug/books'],
  ['get', '/uploads/limits'],
  ['get', '/versions/:bookVersionId/audio-chapters'],
  ['get', '/versions/:bookVersionId/chapters'],
  ['get', '/versions/:bookVersionId/seo'],
  ['get', '/versions/:bookVersionId/summary'],
  ['get', '/versions/:id'],
  ['get', '/versions/:id/preview'],
  ['get', '/views/aggregate'],
  ['get', '/views/top'],
  ['post', '/auth/login'],
  ['post', '/auth/logout'],
  ['post', '/auth/refresh'],
  ['post', '/auth/register'],
  ['post', '/auth/social'],
  ['post', '/rights/agent/submissions'],
  ['post', '/views'],
];

/** Ниже этих чисел обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_ROUTES_CHECKED = 200;
const MIN_CONTROLLERS_SEEN = 40;

/** Значение для `:param`: гвард отвечает раньше, чем кто-нибудь его разберёт. */
const PARAM_STUB = '00000000-0000-0000-0000-000000000000';

/**
 * Чем стучаться. `@All(...)` HTTP-глаголом не является — берём `get`;
 * остальные семь supertest поддерживает как есть.
 */
const PROBE: Record<HttpVerb, 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'> = {
  get: 'get',
  post: 'post',
  put: 'put',
  patch: 'patch',
  delete: 'delete',
  head: 'head',
  options: 'options',
  all: 'get',
};

const withParams = (path: string): string =>
  path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? PARAM_STUB : segment))
    .join('/');

const keyOf = (verb: HttpVerb, path: string): string => verb + ' ' + path;

describe('LEGACY-234 — закрытый маршрут отвечает 401 без токена (e2e)', () => {
  let app: INestApplication;

  const { closed, open, skipped } = collectRoutes('JwtAuthGuard');
  const allRoutes = [...closed, ...open];
  const publicKeys = new Set(PUBLIC_ROUTES.map(([verb, path]) => keyOf(verb, path)));
  const mustBeClosed = allRoutes.filter((route) => !publicKeys.has(keyOf(route.verb, route.path)));

  beforeAll(async () => {
    // Набор шлёт больше двухсот запросов с одного адреса в одном кейсе,
    // а `RATE_LIMIT_GLOBAL_MAX` по умолчанию 100: без этого 429 приходил бы
    // вместо 401 и читался как открытый маршрут.
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(`обходит не меньше ${MIN_CONTROLLERS_SEEN} контроллеров и ни одного не пропускает`, () => {
    const files = new Set(allRoutes.map((route) => route.file));
    expect(files.size).toBeGreaterThanOrEqual(MIN_CONTROLLERS_SEEN);
    expect(skipped).toEqual([]);
  });

  it(`проверяет не меньше ${MIN_ROUTES_CHECKED} маршрутов`, () => {
    expect(mustBeClosed.length).toBeGreaterThanOrEqual(MIN_ROUTES_CHECKED);
  });

  it('не знает публичных маршрутов, которых нет в коде', () => {
    const actual = new Set(allRoutes.map((route) => keyOf(route.verb, route.path)));
    const stale = [...publicKeys].filter((key) => !actual.has(key));
    expect(stale).toEqual([]);
  });

  it('у каждого маршрута публичного списка в коде действительно нет JwtAuthGuard', () => {
    const openKeys = new Set(open.map((route) => keyOf(route.verb, route.path)));
    const guardedButListed = [...publicKeys].filter((key) => !openKeys.has(key));
    expect(guardedButListed).toEqual([]);
  });

  it('каждый маршрут вне публичного списка отвечает 401 без токена', async () => {
    const wrong: string[] = [];

    for (const route of mustBeClosed) {
      const res = await request(httpServerOf(app))[PROBE[route.verb]](withParams(route.path));
      if (res.status !== 401) {
        wrong.push(`${route.verb.toUpperCase()} ${route.path} -> ${res.status} (${route.file})`);
      }
    }

    expect(wrong).toEqual([]);
  }, 120_000);
});
