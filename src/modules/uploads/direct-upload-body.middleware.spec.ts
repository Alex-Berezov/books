import {
  Controller,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  Req,
  RequestMethod,
  Get,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Request } from 'express';
import { DirectUploadBodyMiddleware } from './direct-upload-body.middleware';
import { UploadsService } from './uploads.service';
import { UploadsModule } from './uploads.module';

const directHandler = jest.fn((req: Request) => ({
  bytes: Buffer.isBuffer(req.body) ? req.body.length : -1,
}));

@Controller('uploads')
class DirectUploadController {
  @Post('direct')
  direct(@Req() req: Request) {
    return directHandler(req);
  }

  @Get('direct')
  probe() {
    return { ok: true };
  }
}

/** Живой токен `live` с потолком 110 байт; любой другой — истёкший; `broken` — отказ кэша. */
const uploadsStub = {
  directUploadBodyLimit: jest.fn((token: string) => {
    if (token === 'broken') return Promise.reject(new Error('cache down'));
    return Promise.resolve(token === 'live' ? 110 : undefined);
  }),
};

@Module({
  controllers: [DirectUploadController],
  providers: [{ provide: UploadsService, useValue: uploadsStub }],
})
class DirectUploadTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(DirectUploadBodyMiddleware)
      .forRoutes({ path: 'uploads/direct', method: RequestMethod.POST });
  }
}

/**
 * `LEGACY-459`. Тело `POST /api/uploads/direct` читается только по живому upload-токену
 * и не больше потолка, который даёт сервис; без токена — 401 до чтения тела.
 */
describe('DirectUploadBodyMiddleware (LEGACY-459)', () => {
  let app: INestApplication;
  const http = () => app.getHttpServer() as import('http').Server;
  const post = (body: Buffer, token?: string) => {
    const req = request(http()).post('/api/uploads/direct').set('Content-Type', 'audio/mpeg');
    if (token !== undefined) req.set('X-Upload-Token', token);
    return req.send(body);
  };

  beforeEach(async () => {
    directHandler.mockClear();
    uploadsStub.directUploadBodyLimit.mockClear();
    const moduleRef = await Test.createTestingModule({
      imports: [DirectUploadTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('401 without an upload token: the service and the handler are never reached', async () => {
    const res = await post(Buffer.alloc(50));
    expect(res.status).toBe(401);
    expect(res.headers.connection).toBe('close');
    expect(uploadsStub.directUploadBodyLimit).not.toHaveBeenCalled();
    expect(directHandler).not.toHaveBeenCalled();
  });

  it('401 with a blank upload token', async () => {
    const res = await post(Buffer.alloc(50), '   ');
    expect(res.status).toBe(401);
    expect(uploadsStub.directUploadBodyLimit).not.toHaveBeenCalled();
  });

  it('401 with an unknown or expired upload token', async () => {
    const res = await post(Buffer.alloc(50), 'stale');
    expect(res.status).toBe(401);
    expect(uploadsStub.directUploadBodyLimit).toHaveBeenCalledTimes(1);
    expect(directHandler).not.toHaveBeenCalled();
  });

  it('500 from the standard filter when the token store fails — not a hanging request', async () => {
    const res = await post(Buffer.alloc(50), 'broken');
    expect(res.status).toBe(500);
    expect(directHandler).not.toHaveBeenCalled();
  });

  it('413 when the body exceeds the limit for the token', async () => {
    const res = await post(Buffer.alloc(111), 'live');
    expect(res.status).toBe(413);
    expect(directHandler).not.toHaveBeenCalled();
  });

  it('passes the body within the limit', async () => {
    const res = await post(Buffer.alloc(110), 'live');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ bytes: 110 });
  });

  it('other methods are not touched', async () => {
    const res = await request(http()).get('/api/uploads/direct');
    expect(res.status).toBe(200);
    expect(uploadsStub.directUploadBodyLimit).not.toHaveBeenCalled();
  });

  it('UploadsModule mounts it on POST /uploads/direct only', () => {
    const forRoutes = jest.fn();
    const apply = jest.fn(() => ({ forRoutes }));
    new UploadsModule().configure({ apply } as unknown as MiddlewareConsumer);
    expect(apply).toHaveBeenCalledWith(DirectUploadBodyMiddleware);
    expect(forRoutes.mock.calls).toEqual([
      [{ path: 'uploads/direct', method: RequestMethod.POST }],
    ]);
  });
});
