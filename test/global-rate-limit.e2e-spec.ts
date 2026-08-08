import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * LEGACY-064. Две гарантии, обе проверяются здесь по-настоящему, через HTTP.
 *
 * 1. Отказ лимитера — **429 с `Retry-After`**, а не 403. Разница не косметическая:
 *    403 читается как «тебе сюда нельзя» и Googlebot по нему надолго снижает
 *    частоту обхода, 429 — как «повтори позже».
 * 2. `CF-Connecting-IP` **не даёт новую корзину**, если запрос пришёл не из
 *    диапазона Cloudflare. Иначе лимит обходится подстановкой заголовка: каждый
 *    запрос объявляет себя новым посетителем.
 */
describe('Global rate limit (LEGACY-064) e2e', () => {
  let app: INestApplication;
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const previous = {
    enabled: process.env.RATE_LIMIT_GLOBAL_ENABLED,
    max: process.env.RATE_LIMIT_GLOBAL_MAX,
    window: process.env.RATE_LIMIT_GLOBAL_WINDOW_MS,
  };

  // Публичный маршрут, который лимитер не пропускает мимо себя (в отличие от
  // /health и /api/docs) и который дёшев для сервера.
  const PATH = '/en/categories?type=collection&limit=1';

  beforeAll(async () => {
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '1';
    process.env.RATE_LIMIT_GLOBAL_MAX = '3';
    process.env.RATE_LIMIT_GLOBAL_WINDOW_MS = '60000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // e2e в CI идут через `--runInBand`: оставленные переменные включили бы
    // глобальный лимитер и для наборов, которые поднимаются после этого.
    for (const [key, value] of [
      ['RATE_LIMIT_GLOBAL_ENABLED', previous.enabled],
      ['RATE_LIMIT_GLOBAL_MAX', previous.max],
      ['RATE_LIMIT_GLOBAL_WINDOW_MS', previous.window],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('answers 429 with Retry-After once the quota is spent, not 403', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await request(http()).get(PATH);
      expect(res.status).not.toBe(429);
      expect(res.status).not.toBe(403);
    }

    const refused = await request(http()).get(PATH).expect(429);

    expect(refused.headers['retry-after']).toBe('60');
    expect((refused.body as { retryAfter?: number }).retryAfter).toBe(60);
  });

  it('does not hand out a fresh quota to a forged CF-Connecting-IP', async () => {
    // Каждый запрос называет себя новым посетителем. Приходят они с 127.0.0.1 —
    // адреса, которого нет в диапазонах Cloudflare, поэтому заголовок обязан быть
    // проигнорирован и все запросы должны считаться одной корзиной.
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(http())
        .get(PATH)
        .set('CF-Connecting-IP', `198.51.100.${i + 1}`);
      codes.push(res.status);
    }

    expect(codes).toContain(429);
  });
});
