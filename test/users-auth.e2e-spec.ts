/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Users authorized e2e', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('me and updateMe happy path', async () => {
    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    const token = reg.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.email).toBe(email);

    const updated = await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Tester', avatarUrl: 'https://example.com/a.png', languagePreference: 'es' })
      .expect(200);

    expect(updated.body.name).toBe('Tester');
    expect(updated.body.avatarUrl).toBe('https://example.com/a.png');
    expect(updated.body.languagePreference).toBe('es');
  });

  it('refresh -> access protected route', async () => {
    const email = `refresh_${Date.now()}@example.com`;
    const password = 'password123';

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    const refresh = reg.body.refreshToken as string;

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refresh })
      .expect(200);

    const access = refreshed.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${access}`)
      .expect(200);
    expect(me.body.email).toBe(email);
  });

  it('non-admin forbidden on admin routes', async () => {
    const uEmail = `nonadmin_${Date.now()}@example.com`;
    const uPass = 'password123';

    const uReg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uEmail, password: uPass })
      .expect(201);

    const uLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: uEmail, password: uPass })
      .expect(200);

    const uToken = uLogin.body.accessToken as string;

    await request(app.getHttpServer())
      .get(`/users/${uReg.body.user.id}`)
      .set('Authorization', `Bearer ${uToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/users/${uReg.body.user.id}`)
      .set('Authorization', `Bearer ${uToken}`)
      .expect(403);
  });

  it('admin GET/DELETE by id', async () => {
    // normal user
    const uEmail = `normal_${Date.now()}@example.com`;
    const uPass = 'password123';
    const uReg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uEmail, password: uPass })
      .expect(201);
    const userId = uReg.body.user.id as string;

    // admin user (email in ADMIN_EMAILS)
    const aEmail = 'admin@example.com';
    const aPass = 'password123';
    const regAdmin = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: aEmail, password: aPass });

    if (![201, 409].includes(regAdmin.status)) {
      throw new Error(`Unexpected admin register status: ${regAdmin.status}`);
    }

    const aLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: aEmail, password: aPass })
      .expect(200);
    const aToken = aLogin.body.accessToken as string;

    const getById = await request(app.getHttpServer())
      .get(`/users/${userId}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(getById.body.id).toBe(userId);

    const del = await request(app.getHttpServer())
      .delete(`/users/${userId}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(del.body.id).toBe(userId);

    await request(app.getHttpServer())
      .get(`/users/${userId}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(404);
  });
});
