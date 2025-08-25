/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Tags e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let versionId: string;
  let tagId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // create book + version
    const book = await prisma.book.create({ data: { slug: `book-tag-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
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

    // login admin
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

  it('CRUD tag (admin only) and attach/detach to version', async () => {
    // create tag
    const createRes = await request(http())
      .post('/tags')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Motivation E2E', slug: `motivation-e2e-${Date.now()}` })
      .expect(201);
    tagId = createRes.body.id as string;

    // list
    await request(http()).get('/tags?page=1&limit=1').expect(200);

    // update
    await request(http())
      .patch(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Motivation Updated' })
      .expect(200);

    // attach
    await request(http())
      .post(`/versions/${versionId}/tags`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ tagId })
      .expect(201);

    // duplicate attach is idempotent
    await request(http())
      .post(`/versions/${versionId}/tags`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ tagId })
      .expect(201);

    // get books by tag slug
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    await request(http())
      .get(`/tags/${tag?.slug as string}/books`)
      .expect(200);

    // detach
    await request(http())
      .delete(`/versions/${versionId}/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    // delete tag
    await request(http())
      .delete(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });
});
