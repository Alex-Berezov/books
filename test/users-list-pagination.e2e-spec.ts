import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';

/**
 * LEGACY-118. `GET /users` отвечал 400 на любой `page` и `limit`: в
 * `ListUsersQueryDto` не было `@Type(() => Number)`, а глобальный `ValidationPipe`
 * создан без `enableImplicitConversion`, то есть из query приходила строка и
 * `@IsInt` её отвергал. Дефолты работали, потому что при отсутствии параметра
 * валидатор до них не доходит — отсюда впечатление, что маршрут исправен.
 *
 * ⚠️ Пайп здесь настраивается **как в `src/main.ts`** (`transform: true`).
 * Соседние спеки `users.e2e-spec.ts` и `users-auth.e2e-spec.ts` поднимают его без
 * `transform`, и на такой конфигурации разговор о приведении типов бессмысленен.
 */
describe('Users list pagination e2e (LEGACY-118)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(httpServerOf(app)).post('/auth/register').send({ email, password });
    if (![201, 409].includes(reg.status)) {
      throw new Error(`Unexpected admin register status: ${reg.status}`);
    }
    const login = await request(httpServerOf(app))
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    adminToken = (login.body as { accessToken: string }).accessToken;

    // Больше одной страницы при limit=5: список должен быть чем листать.
    // Статус проверяется — молча провалившаяся регистрация оставила бы вторую
    // страницу пустой, и тест прошёл бы, ничего не проверив.
    for (let i = 0; i < 6; i++) {
      await request(httpServerOf(app))
        .post('/auth/register')
        .send({ email: `list_${Date.now()}_${i}@example.com`, password })
        .expect(201);
    }
  });

  const page = async (
    query: string,
  ): Promise<{ items: Array<{ id: string }>; total: number; page: number; limit: number }> => {
    const res = await request(httpServerOf(app))
      .get(`/users?${query}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return res.body as { items: Array<{ id: string }>; total: number; page: number; limit: number };
  };

  afterAll(async () => {
    await app.close();
  });

  it('returns the second page, not just an echo of the parameters', async () => {
    const first = await page('page=1&limit=5');
    const second = await page('page=2&limit=5');

    // Числа, а не строки: иначе приведение не сработало, а маршрут просто
    // перестал валидировать вход.
    expect(second.page).toBe(2);
    expect(second.limit).toBe(5);
    expect(first.total).toBeGreaterThan(5);

    // 🔴 Эха параметров мало: `skip: 0` вместо `(page - 1) * limit` вернул бы
    // ту же первую страницу с правильными `page` и `limit` в теле. Проверяются
    // сами записи: обе страницы полны и не пересекаются.
    expect(first.items).toHaveLength(5);
    expect(second.items.length).toBeGreaterThan(0);

    const firstIds = first.items.map((u) => u.id);
    const secondIds = second.items.map((u) => u.id);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it('still rejects values outside the declared bounds', async () => {
    // Парная проверка к предыдущей: `@Type` приводит тип, но не отменяет
    // `@Min` и `@Max`. Без неё «починкой» сошло бы и снятие валидации целиком.
    await request(httpServerOf(app))
      .get('/users?limit=1000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    await request(httpServerOf(app))
      .get('/users?page=0')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
