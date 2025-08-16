/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Chapters e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bookId: string;
  let versionId: string;

  // Auth tokens
  let userAccess: string;
  let adminAccess: string;

  // Strongly typed helper to avoid unsafe any from Nest's getHttpServer()
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    // Force admin env for this test to avoid polluted .env values
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Create a book and version to attach chapters to
    const book = await prisma.book.create({ data: { slug: `book-${Date.now()}` } });
    bookId = book.id;
    const version = await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    // Register regular user
    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const regUser = await request(http())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    userAccess = regUser.body.accessToken as string;

    // Register admin (email must be in ADMIN_EMAILS env to pass RolesGuard)
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
      console.log('admin register unexpected', regAdmin.status, regAdmin.body);
      throw new Error('Admin register failed');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('forbids creating chapter without auth', async () => {
    await request(http())
      .post(`/versions/${versionId}/chapters`)
      .send({ number: 1, title: 'Ch1', content: 'Text' })
      .expect(401);
  });

  it('forbids creating chapter for non-admin/non-manager user', async () => {
    await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ number: 1, title: 'Ch1', content: 'Text' })
      .expect(403);
  });

  it('admin can create/list/get/update/delete chapter and pagination works', async () => {
    // Create
    const created = await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 1, title: 'Ch1', content: 'Text 1' })
      .expect(201);
    const chapterId = created.body.id as string;

    // Create a second chapter for pagination
    await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 2, title: 'Ch2', content: 'Text 2' })
      .expect(201);

    // List with limit=1 (pagination)
    const list1 = await request(http())
      .get(`/versions/${versionId}/chapters?limit=1&page=1`)
      .expect(200);
    expect(Array.isArray(list1.body)).toBe(true);
    expect(list1.body.length).toBe(1);
    expect(list1.body[0].number).toBe(1);

    const list2 = await request(http())
      .get(`/versions/${versionId}/chapters?limit=1&page=2`)
      .expect(200);
    expect(list2.body.length).toBe(1);
    expect(list2.body[0].number).toBe(2);

    // Get
    await request(http()).get(`/chapters/${chapterId}`).expect(200);

    // Update
    await request(http())
      .patch(`/chapters/${chapterId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ title: 'New Title' })
      .expect(200);

    // Delete
    await request(http())
      .delete(`/chapters/${chapterId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });

  it('enforces uniqueness of chapter number within version', async () => {
    // Create number 3 twice
    await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'Ch3', content: 'Text 3' })
      .expect(201);
    await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ number: 3, title: 'Ch3 dup', content: 'Dup' })
      .expect(400);
  });
});
