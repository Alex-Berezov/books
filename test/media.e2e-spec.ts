/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Smoke e2e for Media library: confirm -> list -> delete
// NOTE: This suite is skipped by default until DB migrations with MediaAsset are applied locally.
// Remove ".skip" once you run prisma migrate to create MediaAsset table.
describe('Media e2e', () => {
  let app: INestApplication;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // register or login admin
    const password = 'password123';
    const adminEmail = 'admin@example.com';
    const regAdmin = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password });
    if (regAdmin.status === 201) {
      adminAccess = regAdmin.body.accessToken as string;
    } else if (regAdmin.status === 409) {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: adminEmail, password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    } else {
      throw new Error('Admin register failed');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('confirm, list, delete', async () => {
    // Simulate that file was uploaded via /uploads
    const key = `covers/2025/08/26/${Date.now()}.jpg`;
    const url = `http://localhost:3000/${key}`;

    // Confirm
    const confirmRes = await request(http())
      .post('/media/confirm')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key, url, contentType: 'image/jpeg', size: 12345, width: 10, height: 10 })
      .expect(201);

    const id = confirmRes.body.id as string;

    // Idempotent confirm
    await request(http())
      .post('/media/confirm')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key, url, contentType: 'image/jpeg', size: 12345 })
      .expect(201);

    // List
    await request(http())
      .get('/media?page=1&limit=5&q=covers&type=image/')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // Delete
    await request(http())
      .delete(`/media/${id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
  });

  /**
   * LEGACY-060 на живой базе.
   *
   * Юнит-тест этого не заменяет: там Prisma замокана, и ошибка в имени поля или в
   * форме запроса прошла бы зелёной. Здесь проверяется, что запрос действительно
   * находит ссылку в `BookVersion.coverImageUrl` — колонке, а не в моке.
   */
  it('refuses to delete a cover a published book still uses', async () => {
    const prisma = app.get(PrismaService);

    const key = `covers/legacy-060/${Date.now()}.jpg`;
    const url = `http://localhost:3000/${key}`;

    const confirmRes = await request(http())
      .post('/media/confirm')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ key, url, contentType: 'image/jpeg', size: 100 })
      .expect(201);
    const mediaId = confirmRes.body.id as string;

    const book = await prisma.book.create({ data: { slug: `book-media-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Cover Owner',
        author: 'A',
        description: 'D',
        // Ровно тот случай из отчёта: связь — строка URL, а не внешний ключ.
        coverImageUrl: url,
        type: 'text',
        isFree: true,
        status: 'published',
      },
    });

    const refused = await request(http())
      .delete(`/media/${mediaId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(409);

    expect(refused.body.references).toEqual([`book version "Cover Owner" (${version.id})`]);

    // Запись не помечена удалённой: отказ обязан быть полным.
    const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    expect(asset?.isDeleted).toBe(false);

    // Убрали ссылку — удаление снова разрешено.
    await prisma.bookVersion.delete({ where: { id: version.id } });
    await request(http())
      .delete(`/media/${mediaId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    await prisma.book.delete({ where: { id: book.id } });
  });
});
