/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { grantStaffRoles } from './helpers/staff-roles';

describe('Users authorized e2e', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // `transform: true` - как в боевом `src/main.ts`: без него нормализация email из DTO
    // (`@NormalizeEmail`, LEGACY-443) до обработчика не доезжает.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
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

    // admin user: the role is written by grantStaffRoles (LEGACY-443), not by registration
    const aEmail = 'admin@example.com';
    const aPass = 'password123';
    const regAdmin = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: aEmail, password: aPass });

    if (![201, 409].includes(regAdmin.status)) {
      throw new Error(`Unexpected admin register status: ${regAdmin.status}`);
    }
    await grantStaffRoles(app, aEmail);

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

  // LEGACY-443: админское создание пишет тот же `User.email`, что регистрация, - в нижнем регистре.
  it('admin POST /users: адрес в другом регистре - тот же аккаунт, 409', async () => {
    const aEmail = `users_case_admin_${Date.now()}@example.com`;
    const pass = 'password123';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: aEmail, password: pass })
      .expect(201);
    await grantStaffRoles(app, aEmail);
    const aToken = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: aEmail, password: pass })
        .expect(200)
    ).body.accessToken as string;

    const email = `users_case_${Date.now()}@example.com`;
    const created = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ email: ` ${email.toUpperCase()} `, password: pass })
      .expect(201);
    expect(created.body.email).toBe(email);

    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${aToken}`)
      .send({ email, password: pass })
      .expect(409);
  });
});
