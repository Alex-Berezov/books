/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Auth e2e', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
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
});
