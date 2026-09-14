/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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

  it('GET /queues/demo/stats (admin) answers by Redis availability', async () => {
    const token = await getAdminToken();

    // Выключенный контур отвечает тем же отказом, что и enqueue (решение арбитра 14.09.2026):
    // нули были бы неотличимы от живой пустой очереди.
    if (!queuesEnabled) {
      const refused = await request(http())
        .get('/queues/demo/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(503);
      expect(String((refused.body as { message?: string }).message)).toContain('no Redis config');
      return;
    }

    const res = await request(http())
      .get('/queues/demo/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Форма одна на обе ветки: и с Redis, и без него ручка отдаёт все шесть счётчиков числами
    // (`LEGACY-016`, 14.09.2026). Прежнее `toBeDefined()` пропускало любое тело, включая пустое,
    // и смену формы не заметило бы вовсе.
    expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual([
      'active',
      'completed',
      'delayed',
      'failed',
      'paused',
      'waiting',
    ]);
    for (const value of Object.values(res.body as Record<string, unknown>)) {
      expect(typeof value).toBe('number');
    }
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
