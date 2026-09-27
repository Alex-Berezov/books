/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * `LEGACY-015` пункт 3, пачка `T45`: ручка чтения журнала `GET /admin/audit-events`
 * на живой базе. Права (401 без токена, 403 у `content_manager`), связка фильтра
 * `targetType`+`targetId` и отсутствие почты актёра в ответе — HTTP-слой, юнит
 * сервиса его не видит.
 */
describe('LEGACY-015 T45: GET /admin/audit-events (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let cmToken: string;
  let cmId: string;
  const adminEmailsBefore = process.env.ADMIN_EMAILS;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
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
  });

  afterAll(async () => {
    if (adminEmailsBefore === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = adminEmailsBefore;
    }
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
