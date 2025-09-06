import { INestApplication, Module, Controller, Post, Get, Body, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
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

  afterEach(async () => {
    if (app) await app.close();
  });

  it('applies Helmet headers by default', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    configureSecurity(app);
    await app.init();

    const res = await request(app.getHttpServer()).get('/echo/headers');
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
      .set('Access-Control-Request-Method', 'POST');
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
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
});
