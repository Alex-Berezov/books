/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Users e2e', () => {
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

  it('me and updateMe require auth', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);
    await request(app.getHttpServer()).patch('/users/me').send({ name: 'Test' }).expect(401);
  });
});
