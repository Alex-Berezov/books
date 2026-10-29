import { Controller, INestApplication, Post, UseInterceptors } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  FORM_FIELD_MAX_BYTES,
  FORM_FIELD_NAME_MAX_BYTES,
  FormFileInterceptor,
} from './form-file.interceptor';
import { registerGlobalFilters } from '../filters/register-global-filters';
import { PRIVATE_NO_STORE } from './cache-control';

const FILE_LIMIT = 16;

@Controller()
class ProbeController {
  @Post('ok')
  @UseInterceptors(FormFileInterceptor('file', FILE_LIMIT, 2))
  ok() {
    return { ok: true };
  }

  @Post('boom')
  @UseInterceptors(FormFileInterceptor('file', FILE_LIMIT, 2))
  boom(): never {
    throw new Error('handler failure');
  }
}

/**
 * LEGACY-475. Потолки полей формы и отказ multer: коды, которых не знает `transformException`
 * Nest 11.2.7, уходят 400 через глобальный фильтр (с `Vary: Authorization`), а не 500.
 */
describe('FormFileInterceptor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    // Умолчание приложения (`defaultCacheControl`): приватный ответ, на отказе — `Vary`.
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', PRIVATE_NO_STORE);
      next();
    });
    registerGlobalFilters(app, false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path = '/ok', file = Buffer.from('bytes')) =>
    request(app.getHttpServer() as Server)
      .post(path)
      .attach('file', file, { filename: 'a.bin', contentType: 'application/octet-stream' });

  it('lets a form within the limits through', async () => {
    await post().field('a', '1').field('b', '2').expect(201);
  });

  it('answers 400 with Vary: Authorization on a sparse array index', async () => {
    const res = await post().field('a[4294967294]', 'x').expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Field name array index too large - a[4294967294]',
    );
    expect(res.headers.vary).toMatch(/Authorization/);
  });

  it('rejects any non-zero array index', async () => {
    await post().field('a[1]', 'x').expect(400);
  });

  it('rejects more fields than declared', async () => {
    const res = await post().field('a', '1').field('b', '2').field('c', '3').expect(400);
    expect((res.body as { message: string }).message).toMatch(/Too many fields/);
  });

  it('rejects a field value over the cap', async () => {
    await post()
      .field('a', 'x'.repeat(FORM_FIELD_MAX_BYTES + 1))
      .expect(400);
  });

  it('rejects a field name over the cap', async () => {
    await post()
      .field('a'.repeat(FORM_FIELD_NAME_MAX_BYTES + 1), '1')
      .expect(400);
  });

  it('rejects a second file', async () => {
    await post().attach('file', Buffer.from('x'), { filename: 'b.bin' }).expect(400);
  });

  it('keeps 413 for an oversized file', async () => {
    await post('/ok', Buffer.alloc(FILE_LIMIT + 1)).expect(413);
  });

  it('does not turn a handler error into 400', async () => {
    await post('/boom').expect(500);
  });
});
