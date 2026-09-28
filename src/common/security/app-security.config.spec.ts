import { INestApplication, Module, Controller, Post, Get, Body, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Request } from 'express';
import { configureSecurity } from './app-security.config';

@Controller('echo')
class EchoController {
  @Post('json')
  echoJson(@Body() body: Record<string, unknown>) {
    return body;
  }

  @Post('url')
  echoUrl(@Body() body: Record<string, unknown>) {
    return body;
  }

  @Get('headers')
  getHeaders(@Req() req: Request) {
    return { ok: true, headers: req.headers };
  }
}

@Module({ controllers: [EchoController] })
class TestModule {}

describe('Security config (Helmet, CORS, limits)', () => {
  let app: INestApplication;
  const envBefore = {
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    BODY_LIMIT_JSON: process.env.BODY_LIMIT_JSON,
    BODY_LIMIT_URLENCODED: process.env.BODY_LIMIT_URLENCODED,
  };

  afterEach(async () => {
    if (app) await app.close();
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('applies Helmet headers by default', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    const res = await request(app.getHttpServer() as import('http').Server).get('/echo/headers');
    expect(res.status).toBe(200);
    // A few typical helmet headers
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('enables CORS for allowed origin and reflects preflight', async () => {
    process.env.CORS_ORIGIN = 'http://example.com';
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    const origin = 'http://example.com';
    const preflight = await (
      request as unknown as (server: unknown) => request.SuperTest<request.Test>
    )(app.getHttpServer())
      .options('/echo/json')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-upload-token');
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    // 🔴 Заголовок проверяется на живом ответе, а не в объекте конфигурации: `cors.config.spec.ts`
    // сверяет список сам с собой и останется зелёным, если `configureSecurity` перестанет
    // передавать `allowedHeaders` в `enableCors` или если сырое тело встанет раньше CORS.
    // Без `X-Upload-Token` в ответе браузер не отправляет тело прямой загрузки вовсе
    // (`LEGACY-372`) — ни 401, ни строчки в логе.
    expect(preflight.headers['access-control-allow-headers']).toContain('X-Upload-Token');
  });

  it('applies JSON and URL-encoded body limits (1mb default)', async () => {
    delete process.env.BODY_LIMIT_JSON;
    delete process.env.BODY_LIMIT_URLENCODED;
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    // Build a payload slightly over 1mb (1,050,000 bytes)
    const big = 'x'.repeat(1_050_000);
    // JSON
    const resJson = await request(app.getHttpServer() as import('http').Server)
      .post('/echo/json')
      .set('Content-Type', 'application/json')
      .send({ big });
    expect([413, 400]).toContain(resJson.status); // 413 Payload Too Large expected, but some envs may return 400

    // URL-encoded
    const resUrl = await request(app.getHttpServer() as import('http').Server)
      .post('/echo/url')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`big=${encodeURIComponent(big)}`);
    expect([413, 400]).toContain(resUrl.status);
  });

  /**
   * `LEGACY-108` остаток (`T64`). Preflight отдаёт `cors` сам, обрывая цепочку
   * до `DefaultCacheControlMiddleware` (тот регистрируется модулем позже, при
   * `app.init()`) — без директивы общий кэш вправе хранить ответ эвристически
   * (RFC 9111 §4.2.2).
   */
  it('OPTIONS preflight response is not cacheable (LEGACY-108 остаток T64)', async () => {
    process.env.CORS_ORIGIN = 'http://example.com';
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    app.setGlobalPrefix('api');
    await app.init();

    const preflight = await (
      request as unknown as (server: unknown) => request.SuperTest<request.Test>
    )(app.getHttpServer())
      .options('/api/echo/json')
      .set('Origin', 'http://example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers['cache-control']).toBe('private, no-store');
  });

  /**
   * `LEGACY-108` остаток (`T64`). `express.json()` отвечает 413 сам, до того
   * как запрос доходит до `DefaultCacheControlMiddleware` или любого
   * интерцептора/фильтра — то же отсутствие директивы.
   */
  it('413 body-too-large response is not cacheable (LEGACY-108 остаток T64)', async () => {
    delete process.env.BODY_LIMIT_JSON;
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    app.setGlobalPrefix('api');
    await app.init();

    const big = 'x'.repeat(1_050_000);
    const res = await request(app.getHttpServer() as import('http').Server)
      .post('/api/echo/json')
      .set('Content-Type', 'application/json')
      .send({ big });

    expect([413, 400]).toContain(res.status);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  /**
   * 🔴 Умолчание — только под `/api`. Статика `ServeStaticModule` (`serveRoot: '/'`)
   * ставит свой `public, max-age=0` лишь при пустом `Cache-Control` (`send`),
   * и умолчание на весь трафик сделало бы загрузки `private, no-store`.
   */
  it('does not set Cache-Control outside /api', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    const res = await request(app.getHttpServer() as import('http').Server).get('/echo/headers');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
