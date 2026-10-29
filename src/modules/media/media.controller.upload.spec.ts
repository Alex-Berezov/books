import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { UploadsService } from '../uploads/uploads.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { registerGlobalFilters } from '../../common/filters/register-global-filters';

/**
 * LEGACY-475. Настоящий разбор multipart на маршруте: `type` проверяется перечислением
 * до обращения к хранилищу, раздутое имя поля режется лимитом multer и уходит 400.
 */
describe('POST /media/upload — form fields', () => {
  let app: INestApplication;
  const uploads = {
    presign: jest.fn().mockResolvedValue({ token: 't', key: 'covers/a.jpg' }),
    directUpload: jest.fn().mockResolvedValue({ publicUrl: 'https://cdn/covers/a.jpg' }),
  };
  const service = { confirm: jest.fn().mockResolvedValue({ id: 'media-1' }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: MediaService, useValue: service },
        { provide: UploadsService, useValue: uploads },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    registerGlobalFilters(app, false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const upload = (field?: [string, string]) => {
    const req = request(app.getHttpServer() as Server)
      .post('/media/upload')
      .attach('file', Buffer.from('bytes'), { filename: 'a.jpg', contentType: 'image/jpeg' });
    return field ? req.field(field[0], field[1]) : req;
  };

  it.each(['cover', 'audio'])('passes type=%s to presign', async (type) => {
    await upload(['type', type]).expect(201);
    expect(uploads.presign).toHaveBeenCalledTimes(1);
    expect(uploads.presign).toHaveBeenCalledWith(
      expect.objectContaining({ type, contentType: 'image/jpeg', size: 5 }),
      undefined,
    );
  });

  it('defaults to cover when type is absent', async () => {
    await upload().expect(201);
    expect(uploads.presign).toHaveBeenCalledTimes(1);
    expect(uploads.presign).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cover' }),
      undefined,
    );
  });

  // Пустое поле — не «нет поля»: `ParseEnumPipe` с `optional` пропускает только null/undefined.
  it.each(['foo', ''])('rejects type=%j before any storage call', async (type) => {
    await upload(['type', type]).expect(400);
    expect(uploads.presign).not.toHaveBeenCalled();
  });

  it('rejects a repeated type field', async () => {
    const res = await upload(['type', 'cover']).field('type', 'audio').expect(400);
    expect((res.body as { message: string }).message).toMatch(/Too many fields/);
    expect(uploads.presign).not.toHaveBeenCalled();
  });

  it('rejects a sparse array field name instead of building it', async () => {
    const res = await upload(['type[4294967294]', 'x']).expect(400);
    expect((res.body as { message: string }).message).toMatch(/array index/i);
    expect(uploads.presign).not.toHaveBeenCalled();
  });

  it('rejects a second text field', async () => {
    const res = await upload(['type', 'cover']).field('extra', 'x').expect(400);
    expect((res.body as { message: string }).message).toMatch(/Too many fields/);
    expect(uploads.presign).not.toHaveBeenCalled();
  });
});
