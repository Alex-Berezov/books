/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

describe('Uploads e2e (local driver)', () => {
  let app: INestApplication;
  let token: string;
  let userId: string;
  let otherToken: string;
  let moderatorToken: string;
  let prisma: PrismaService;
  const bookIds: string[] = [];
  const mediaKeys: string[] = [];

  beforeAll(async () => {
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
    prisma = app.get(PrismaService);

    // Владелец загрузок - обычный пользователь без ролей сотрудника. Адрес свой у прогона:
    // общий `admin@example.com` соседние спеки делают админом (grantStaffRoles, LEGACY-443),
    // и проверки «не модератор» здесь зависели бы от порядка файлов на общей базе.
    const aEmail = `uploads_owner_${Date.now()}@example.com`;
    const aPass = 'password123';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: aEmail, password: aPass })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: aEmail, password: aPass })
      .expect(200);
    token = login.body.accessToken as string;
    userId = login.body.user.id as string;

    const other = `uploads_other_${Date.now()}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: other, password: aPass })
      .expect(201);
    const otherLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: other, password: aPass })
      .expect(200);
    otherToken = otherLogin.body.accessToken as string;

    // Модератор: роль пишет grantStaffRoles (LEGACY-443), регистрация паролем даёт только `user`.
    const moderator = `uploads_moderator_${Date.now()}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: moderator, password: aPass })
      .expect(201);
    await grantStaffRoles(app, moderator);
    const moderatorLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: moderator, password: aPass })
      .expect(200);
    moderatorToken = moderatorLogin.body.accessToken as string;
  });

  /** Обложка, загруженная и подтверждённая обычным путём; запись MediaAsset - как у `POST /media`. */
  const uploadCover = async (): Promise<{ key: string; publicUrl: string; assetId: string }> => {
    const pres = await request(app.getHttpServer())
      .post('/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'cover', contentType: 'image/png', size: 10 })
      .expect(201);
    const direct = await request(app.getHttpServer())
      .post('/uploads/direct')
      .set('Authorization', `Bearer ${token}`)
      .set('x-upload-token', pres.body.token)
      .set('content-type', 'image/png')
      .send(Buffer.from([137, 80, 78, 71]))
      .expect(201);
    const asset = await prisma.mediaAsset.create({
      data: {
        key: pres.body.key,
        url: direct.body.publicUrl,
        contentType: 'image/png',
        createdById: userId,
      },
    });
    mediaKeys.push(asset.key);
    return { key: pres.body.key, publicUrl: direct.body.publicUrl, assetId: asset.id };
  };

  afterAll(async () => {
    await prisma.bookVersion.deleteMany({ where: { bookId: { in: bookIds } } });
    await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
    await prisma.mediaAsset.deleteMany({ where: { key: { in: mediaKeys } } });
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

    // Без записи MediaAsset удалять может только модератор: загрузивший по presign - нет.
    await request(app.getHttpServer())
      .delete('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .query({ key: pres.body.key })
      .expect(403);
  });

  // 🔴 LEGACY-444: любой вошедший удалял любую обложку каталога.
  describe('DELETE /uploads: права на ключ (LEGACY-444)', () => {
    it('владелец удаляет свою обложку: файл уходит, запись помечена для уборки (LEGACY-421)', async () => {
      const cover = await uploadCover();
      await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${token}`)
        .query({ key: cover.key })
        .expect(200);
      const marked = await prisma.mediaAsset.findUnique({ where: { id: cover.assetId } });
      expect(marked?.isDeleted).toBe(true);
      expect(marked?.deletedAt).toBeInstanceOf(Date);
    });

    it('чужую обложку удалить нельзя: 403, запись на месте', async () => {
      const cover = await uploadCover();
      await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${otherToken}`)
        .query({ key: cover.key })
        .expect(403);
      expect(await prisma.mediaAsset.findUnique({ where: { id: cover.assetId } })).not.toBeNull();
    });

    it('обложка версии книги: 409 даже владельцу', async () => {
      const cover = await uploadCover();
      const book = await createBookFixture(prisma, `legacy444-${Date.now()}`);
      bookIds.push(book.id);
      await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language: 'en',
          title: 't',
          author: 'a',
          description: 'd',
          coverImageUrl: cover.publicUrl,
          type: 'text',
          isFree: true,
        },
      });
      // Владельцу - отказ без перечня ссылок (черновики и правовые записи не для него), модератору - с ним.
      const ownerConflict = await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${token}`)
        .query({ key: cover.key })
        .expect(409);
      expect(ownerConflict.body).not.toHaveProperty('references');
      const staffConflict = await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .query({ key: cover.key })
        .expect(409);
      expect(staffConflict.body.references).toEqual(
        expect.arrayContaining([expect.stringContaining('book version')]),
      );
      expect(await prisma.mediaAsset.findUnique({ where: { id: cover.assetId } })).not.toBeNull();
    });

    it('без входа - 401', async () => {
      await request(app.getHttpServer())
        .delete('/uploads')
        .query({ key: 'covers/2026/10/08/x.png' })
        .expect(401);
    });

    it('ключ вне формы presign обычному пользователю - 400, как и модератору (кейс ниже)', async () => {
      await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${token}`)
        .query({ key: 'rights-private/doc.pdf' })
        .expect(400);
    });

    it('модератор удаляет ключ без записи MediaAsset: 200', async () => {
      const pres = await request(app.getHttpServer())
        .post('/uploads/presign')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'cover', contentType: 'image/png', size: 10 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/uploads/direct')
        .set('Authorization', `Bearer ${token}`)
        .set('x-upload-token', pres.body.token)
        .set('content-type', 'image/png')
        .send(Buffer.from([137, 80, 78, 71]))
        .expect(201);
      expect(await prisma.mediaAsset.findUnique({ where: { key: pres.body.key } })).toBeNull();
      await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .query({ key: pres.body.key })
        .expect(200);
    });

    it('модератор на ключ вне загрузок (rights-private/) - 400', async () => {
      await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .query({ key: 'rights-private/doc.pdf' })
        .expect(400);
    });

    it('модератор на covers/./<ключ> - 400, запись существующего ключа на месте', async () => {
      const cover = await uploadCover();
      const dotted = cover.key.replace(/^covers\//, 'covers/./');
      expect(dotted).not.toBe(cover.key);
      await request(app.getHttpServer())
        .delete('/uploads')
        .set('Authorization', `Bearer ${moderatorToken}`)
        .query({ key: dotted })
        .expect(400);
      const asset = await prisma.mediaAsset.findUnique({ where: { id: cover.assetId } });
      expect(asset?.isDeleted).toBe(false);
    });
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
