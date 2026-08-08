import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * LEGACY-072. Раньше `/api/metrics` отдавал реестр prom-client кому угодно: состав
 * маршрутов, объёмы трафика, коды ответов. Закрыть его гвардом было нельзя, пока
 * этот же адрес опрашивал healthcheck контейнера — проба получала бы 401 и деплой
 * откатывался. Healthcheck переехал на `/api/health/liveness`, и здесь проверяется
 * то, ради чего переезд был нужен.
 *
 * Все три посадки обязаны краснеть на коде без гварда: анонимный запрос отдавал бы
 * 200, обычный пользователь — 200, и только третья осталась бы зелёной.
 */
describe('Metrics access (e2e)', () => {
  let app: INestApplication;
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const adminEmail = 'metrics-admin@example.com';
  const userEmail = 'metrics-user@example.com';
  const password = 'password123';

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = adminEmail;
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

  async function tokenFor(email: string): Promise<string> {
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return (reg.body as { accessToken: string }).accessToken;
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return (login.body as { accessToken: string }).accessToken;
  }

  it('refuses an anonymous request', async () => {
    await request(http()).get('/metrics').expect(401);
  });

  it('refuses an authenticated non-admin', async () => {
    const token = await tokenFor(userEmail);
    await request(http()).get('/metrics').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('serves the registry to an admin', async () => {
    const token = await tokenFor(adminEmail);
    const res = await request(http())
      .get('/metrics')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.text).toContain('# HELP');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});
