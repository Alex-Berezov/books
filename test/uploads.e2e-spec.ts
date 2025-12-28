/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Uploads e2e (local driver)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.LOCAL_PUBLIC_BASE_URL = 'http://localhost:5000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    // login as admin
    const aEmail = 'admin@example.com';
    const aPass = 'password123';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: aEmail, password: aPass })
      .ok(() => true);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: aEmail, password: aPass })
      .expect(200);
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('presign -> direct -> confirm -> GET /static', async () => {
    // presign image
    const pres = await request(app.getHttpServer())
      .post('/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'cover', contentType: 'image/png', size: 10 })
      .expect(201);
    expect(pres.body.key).toBeDefined();
    expect(pres.body.url).toBe('/uploads/direct');
    expect(pres.body.token).toBeDefined();

    // direct
    const buf = Buffer.from([137, 80, 78, 71]); // small PNG header
    const direct = await request(app.getHttpServer())
      .post('/uploads/direct')
      .set('Authorization', `Bearer ${token}`)
      .set('x-upload-token', pres.body.token)
      .set('content-type', 'image/png')
      .send(buf)
      .expect(201);
    expect(direct.body.publicUrl).toContain(pres.body.key);

    // confirm
    const confirm = await request(app.getHttpServer())
      .post('/uploads/confirm')
      .set('Authorization', `Bearer ${token}`)
      .query({ key: pres.body.key })
      .expect(201);
    expect(confirm.body.publicUrl).toBe(direct.body.publicUrl);

    // delete
    await request(app.getHttpServer())
      .delete('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .query({ key: pres.body.key })
      .expect(200);
  });
});
