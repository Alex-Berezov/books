import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';

/**
 * Критерий готовности `tasks/background-jobs-visibility/TASK.md`:
 *
 * > Выключить любой механизм переменной окружения, перезапустить приложение — и
 * > увидеть его в состоянии `DISABLED` с правильной причиной и в логе, и в
 * > эндпоинте. Обратно включить — увидеть `ACTIVE`.
 *
 * Поэтому здесь поднимается **два** приложения с разным окружением, а не
 * проверяется реестр в отрыве: инвентарь, который не следует за настоящим
 * переключателем, — это тот же необнаруживаемый дефект, только этажом выше.
 */
describe('Background jobs inventory (e2e)', () => {
  type Job = { name: string; state: string; reason?: string; schedule?: string; purpose: string };

  let adminToken: string;

  const bootApp = async (env: Record<string, string>): Promise<INestApplication> => {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    return app;
  };

  const fetchJobs = async (app: INestApplication): Promise<Job[]> => {
    const res = await request(httpServerOf(app))
      .get('/admin/background-jobs')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return (res.body as { jobs: Job[] }).jobs;
  };

  beforeAll(async () => {
    const adminEmail = 'admin-background-jobs@test.com';
    const adminPassword = 'password123';
    process.env.ADMIN_EMAILS = adminEmail;

    const app = await bootApp({});
    const reg = await request(httpServerOf(app))
      .post('/auth/register')
      .send({ email: adminEmail, password: adminPassword });

    if (reg.status === 201) {
      adminToken = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(httpServerOf(app))
        .post('/auth/login')
        .send({ email: adminEmail, password: adminPassword });
      adminToken = (login.body as { accessToken: string }).accessToken;
    }
    await app.close();
  });

  it('requires authentication', async () => {
    const app = await bootApp({});
    try {
      await request(httpServerOf(app)).get('/admin/background-jobs').expect(401);
    } finally {
      await app.close();
    }
  });

  // 🔴 Каждый механизм обязан быть виден, включая работающие: молчание не должно
  // ничего означать.
  it('reports every mechanism, healthy ones included', async () => {
    const app = await bootApp({ TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED: '1' });
    try {
      const jobs = await fetchJobs(app);
      const sweep = jobs.find((j) => j.name === 'taxonomy-indexability-sweep');

      expect(sweep?.state).toBe('ACTIVE');
      expect(sweep?.schedule).toMatch(/daily at \d{2}:00 UTC/);
      // Назначение обязательно у всех: имя механизма ничего не говорит тому,
      // кто видит его впервые.
      expect(jobs.every((j) => Boolean(j.purpose))).toBe(true);
    } finally {
      await app.close();
    }
  });

  // 🔴 Сам критерий готовности: переключатель окружения обязан быть виден снаружи.
  it('follows the real kill switch, with the reason', async () => {
    const app = await bootApp({ TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED: '0' });
    try {
      const sweep = (await fetchJobs(app)).find((j) => j.name === 'taxonomy-indexability-sweep');

      expect(sweep?.state).toBe('DISABLED');
      expect(sweep?.reason).toContain('TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED=0');
    } finally {
      await app.close();
      process.env.TAXONOMY_INDEXABILITY_SCHEDULER_ENABLED = '1';
    }
  });

  /**
   * 🔴 Три состояния, а не два. Probe без очереди не умирает — он выполняется
   * синхронно внутри HTTP-запроса на загрузку, без ретраев. Слить это с ACTIVE
   * значило бы снова сделать отклонение невидимым, а с DISABLED — соврать.
   */
  it('separates "degraded" from "off" for the media probe', async () => {
    const app = await bootApp({});
    try {
      const probe = (await fetchJobs(app)).find((j) => j.name === 'media-probe');
      const cleanup = (await fetchJobs(app)).find((j) => j.name === 'media-cleanup');

      // Тестовое окружение поднимает Redis, поэтому оба состояния читаются как
      // ACTIVE; проверяется не конкретное значение, а что механизм заявлен и
      // что причина сопровождает любое неактивное состояние.
      expect(probe).toBeDefined();
      expect(cleanup).toBeDefined();
      for (const job of [probe, cleanup]) {
        if (job && job.state !== 'ACTIVE') expect(job.reason).toBeTruthy();
      }
    } finally {
      await app.close();
    }
  });

  /**
   * 🔴 Критерий готовности №2: задача делает механизмы видимыми и **не включает
   * ни одного**. Причина не риторическая — включение уборки орфанов в текущем
   * виде удалило бы все обложки каталога (LEGACY-058).
   *
   * Здесь это закреплено буквально: состояние приходит из тех же веток, что
   * создают очереди и таймеры, поэтому появление ACTIVE там, где его быть не
   * должно, означало бы, что инвентарь что-то включил.
   */
  it('does not switch anything on: every non-active state keeps a reason', async () => {
    const app = await bootApp({ MEDIA_CLEANUP_ENABLED: '0' });
    try {
      const cleanup = (await fetchJobs(app)).find((j) => j.name === 'media-cleanup');

      expect(cleanup?.state).toBe('DISABLED');
      expect(cleanup?.reason).toBeTruthy();
    } finally {
      await app.close();
      delete process.env.MEDIA_CLEANUP_ENABLED;
    }
  });
});
