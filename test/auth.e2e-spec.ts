/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Auth e2e', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('register -> login -> refresh', async () => {
    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    expect(reg.body.accessToken).toBeDefined();
    expect(reg.body.refreshToken).toBeDefined();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    expect(login.body.accessToken).toBeDefined();
    expect(login.body.refreshToken).toBeDefined();

    const refresh = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    expect(refresh.body.accessToken).toBeDefined();
    expect(refresh.body.refreshToken).toBeDefined();
  });

  // LEGACY-443: тот же адрес другим регистром - тот же аккаунт. Дубль не заводится, вход находит.
  it('email нечувствителен к регистру: повторная регистрация 409, вход по другому регистру проходит', async () => {
    const email = `case_${Date.now()}@example.com`;
    const password = 'password123';

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: ` ${email.toUpperCase()} `, password })
      .expect(201);
    expect(reg.body.user.email).toBe(email);

    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(409);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: email.replace('case_', 'CaSe_'), password })
      .expect(200);
  });
});
