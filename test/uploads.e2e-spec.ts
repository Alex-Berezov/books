/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Uploads e2e (local driver)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.LOCAL_PUBLIC_BASE_URL = 'http://localhost:5000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // `transform: true` повторяет боевой `src/main.ts:77-83`. Без него обвязка
    // e2e ведёт себя иначе, чем прод, и проверка проходит на конфигурации,
    // которой нигде нет (`LEGACY-193`).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
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

  // LEGACY-193. Параметр объявлен как `string`, но при отсутствии приходит
  // `undefined`, и `key.startsWith('covers/')` падал `TypeError`: клиент видел
  // 500, а `SentryExceptionFilter` заводил алерт о падении сервера на кривом
  // запросе. Проверка идёт через HTTP, а не юнитом: сигнатура `key: string`
  // не даёт вызвать обработчик без аргумента, поэтому проводку пайпа
  // к маршруту способен подтвердить только настоящий запрос.
  it('POST /uploads/confirm без key отвечает 400, а не 500', async () => {
    await request(app.getHttpServer())
      .post('/uploads/confirm')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('DELETE /uploads без key отвечает 400, а не 500', async () => {
    await request(app.getHttpServer())
      .delete('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('пустой key отбивается так же, как отсутствующий', async () => {
    await request(app.getHttpServer())
      .post('/uploads/confirm')
      .set('Authorization', `Bearer ${token}`)
      .query({ key: '' })
      .expect(400);
  });
});
