/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * `LEGACY-015` пункт 3, пачка `T45`: ручка чтения журнала `GET /admin/audit-events`
 * на живой базе. Права (401 без токена, 403 у `content_manager` и у `user`), связка фильтра
 * `targetType`+`targetId`, отсечение по одному `action` (пачка `T65`) и отсутствие почты
 * актёра в ответе — HTTP-слой, юнит сервиса его не видит.
 */
describe('LEGACY-015 T45: GET /admin/audit-events (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let cmToken: string;
  let cmId: string;
  let userToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (![201, 409].includes(reg.status)) {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }
    await grantStaffRoles(app, email);
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    adminToken = login.body.accessToken as string;
    adminId = login.body.user.id as string;

    const cmEmail = `roles_t45_${Date.now()}@example.com`;
    const cmReg = await request(http())
      .post('/auth/register')
      .send({ email: cmEmail, password })
      .expect(201);
    cmId = cmReg.body.user.id as string;
    await request(http())
      .post(`/users/${cmId}/roles/content_manager`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const cmLogin = await request(http())
      .post('/auth/login')
      .send({ email: cmEmail, password })
      .expect(200);
    cmToken = cmLogin.body.accessToken as string;

    const userEmail = `plain_user_t65_${Date.now()}@example.com`;
    await request(http()).post('/auth/register').send({ email: userEmail, password }).expect(201);
    const userLogin = await request(http())
      .post('/auth/login')
      .send({ email: userEmail, password })
      .expect(200);
    userToken = userLogin.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('401 без токена', async () => {
    await request(http()).get('/admin/audit-events').expect(401);
  });

  it('403 у content_manager', async () => {
    await request(http())
      .get('/admin/audit-events')
      .set('Authorization', `Bearer ${cmToken}`)
      .expect(403);
  });

  it('403 у роли user', async () => {
    await request(http())
      .get('/admin/audit-events')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });

  it('400 на targetId без targetType', async () => {
    await request(http())
      .get('/admin/audit-events')
      .query({ targetId: cmId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('admin читает выдачу роли по объекту — без почты и имени актёра', async () => {
    const res = await request(http())
      .get('/admin/audit-events')
      .query({ targetType: 'USER', targetId: cmId, action: 'ROLE_ASSIGNED' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(res.body.items).toHaveLength(1);
    const [event] = res.body.items as Array<Record<string, unknown>>;
    expect(Object.keys(event).sort()).toEqual(
      ['action', 'actorUserId', 'createdAt', 'id', 'payload', 'targetId', 'targetType'].sort(),
    );
    expect(event).toMatchObject({
      action: 'ROLE_ASSIGNED',
      targetType: 'USER',
      targetId: cmId,
      actorUserId: adminId,
      payload: { role: 'content_manager' },
    });
    expect(JSON.stringify(res.body)).not.toContain('@example.com');
  });

  it('фильтр по action отсекает другое действие на том же объекте', async () => {
    const targetReg = await request(http())
      .post('/auth/register')
      .send({ email: `action_filter_t65_${Date.now()}@example.com`, password: 'password123' })
      .expect(201);
    const targetId = targetReg.body.user.id as string;
    await request(http())
      .post(`/users/${targetId}/roles/lawyer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await request(http())
      .delete(`/users/${targetId}/roles/lawyer`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const byAction = async (action?: string) =>
      request(http())
        .get('/admin/audit-events')
        .query({ targetType: 'USER', targetId, ...(action ? { action } : {}) })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

    const all = await byAction();
    expect(all.body.pagination.total).toBe(2);

    const assigned = await byAction('ROLE_ASSIGNED');
    expect(assigned.body.items).toHaveLength(1);
    expect(assigned.body.pagination.total).toBe(1);
    expect(assigned.body.items[0]).toMatchObject({
      action: 'ROLE_ASSIGNED',
      payload: { role: 'lawyer' },
    });

    const revoked = await byAction('ROLE_REVOKED');
    expect(revoked.body.items).toHaveLength(1);
    expect(revoked.body.pagination.total).toBe(1);
    expect(revoked.body.items[0]).toMatchObject({
      action: 'ROLE_REVOKED',
      payload: { role: 'lawyer' },
    });
  });

  it('400 на from позже to и на дату без времени', async () => {
    await request(http())
      .get('/admin/audit-events')
      .query({ from: '2026-09-28T00:00:00Z', to: '2026-09-27T00:00:00Z' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(http())
      .get('/admin/audit-events')
      .query({ to: '2026-09-27' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('полная страница журнала без фильтров не несёт ни одной почты', async () => {
    const res = await request(http())
      .get('/admin/audit-events')
      .query({ limit: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body.items)).not.toMatch(/@/);
  });

  it('фильтр по времени отсекает событие вне окна', async () => {
    const res = await request(http())
      .get('/admin/audit-events')
      .query({ targetType: 'USER', targetId: cmId, to: '2000-01-01T00:00:00.000Z' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
});
