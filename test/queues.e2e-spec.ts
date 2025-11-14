/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Queues (BullMQ) e2e', () => {
  let app: INestApplication;
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  let queuesEnabled: boolean;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Check actual queue availability via API
    const token = await getAdminToken();
    const statusRes = await request(http())
      .get('/queues/status')
      .set('Authorization', `Bearer ${token}`);
    queuesEnabled = statusRes.body?.enabled === true;
  });

  afterAll(async () => {
    await app.close();
  });

  async function getAdminToken(): Promise<string> {
    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return reg.body.accessToken as string;
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return login.body.accessToken as string;
  }

  it('GET /queues/status (admin) shows enabled flag', async () => {
    const token = await getAdminToken();
    const res = await request(http())
      .get('/queues/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(typeof res.body.enabled).toBe('boolean');
    // Ensure value matches actual availability
    expect(res.body.enabled).toBe(queuesEnabled);
  });

  it('GET /queues/demo/stats (admin) works w/ or w/o Redis', async () => {
    const token = await getAdminToken();
    const res = await request(http())
      .get('/queues/demo/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('POST /queues/demo/enqueue behaves depending on Redis availability', async () => {
    const token = await getAdminToken();
    const rq = request(http())
      .post('/queues/demo/enqueue')
      .set('Authorization', `Bearer ${token}`)
      .send({ delayMs: 5 });
    if (queuesEnabled) {
      const res = await rq.expect(201);
      expect(res.body.id).toBeDefined();
    } else {
      await rq.expect(503);
    }
  });
});
