import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Окно выдачи админского списка персон (`LEGACY-177`, решение арбитра 13.09.2026).
 *
 * Маршрут исторически принимает `offset`, а не `page`, и после сведения формы
 * ответа к общей обёртке `{items, pagination}` тело стало сообщать `page`.
 * Дальше было два дефекта сразу: `?page=2` отбивался глобальным пайпом
 * (`forbidNonWhitelisted`, `src/main.ts:77`), хотя тело предыдущего ответа
 * именно `page` и называло, а некратное `limit` смещение давало `page`, под
 * которым лежит другое окно строк.
 *
 * 🔴 Почему e2e, а не юнит: первый дефект живёт в связке «глобальный пайп +
 * DTO». Юнит, вызывающий метод сервиса напрямую, пайпа не видит и остаётся
 * зелёным при возврате DTO без поля `page`.
 */
describe('Persons list query (LEGACY-177) e2e', () => {
  let app: INestApplication;
  let adminToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const adminEmail = `persons-query-${Date.now()}@test.com`;
    process.env.ADMIN_EMAILS = adminEmail;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const reg = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password: 'password123' });
    adminToken = (reg.body as { accessToken: string }).accessToken;

    // Три персоны — чтобы вторая страница размера 1 была непустой и отличалась
    // от первой, иначе проверка смещения проходит на пустой выдаче.
    const stamp = Date.now();
    for (const n of [1, 2, 3]) {
      await request(http())
        .post('/admin/persons')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ canonicalName: `Persons query ${stamp} ${n}` })
        .expect(201);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  type PersonsPage = {
    items: Array<{ id: string }>;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  };

  it('принимает page — его же он сообщает в теле ответа', async () => {
    const res = await request(http())
      .get('/admin/persons?page=2&limit=1')
      .set('Authorization', `Bearer ${adminToken}`);

    // До правки здесь было 400 `property page should not exist`.
    expect(res.status).toBe(200);
    expect((res.body as PersonsPage).pagination.page).toBe(2);
  });

  it('page и offset вместе не дают 400 — выигрывает page', async () => {
    const res = await request(http())
      .get('/admin/persons?page=2&offset=40&limit=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect((res.body as PersonsPage).pagination.page).toBe(2);
  });

  it('страница по page и страница по кратному offset — это одни и те же строки', async () => {
    const byPage = await request(http())
      .get('/admin/persons?page=2&limit=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const byOffset = await request(http())
      .get('/admin/persons?offset=1&limit=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // 🔴 Сравниваются сами строки, а не номер страницы: совпадение `page`
    // при разной выдаче — ровно тот дефект, ради которого спека заведена.
    expect((byOffset.body as PersonsPage).items.map((p) => p.id)).toEqual(
      (byPage.body as PersonsPage).items.map((p) => p.id),
    );
    expect((byOffset.body as PersonsPage).pagination.page).toBe(2);
  });

  it('некратное смещение выравнивается до границы страницы, а не врёт про page', async () => {
    const aligned = await request(http())
      .get('/admin/persons?offset=2&limit=2')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const skewed = await request(http())
      .get('/admin/persons?offset=3&limit=2')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Обе позиции лежат на второй странице размера 2, и выдача обязана быть
    // одинаковой: иначе тело сообщает один и тот же `page` для разных окон.
    expect((skewed.body as PersonsPage).pagination.page).toBe(2);
    expect((skewed.body as PersonsPage).items.map((p) => p.id)).toEqual(
      (aligned.body as PersonsPage).items.map((p) => p.id),
    );
  });
});
