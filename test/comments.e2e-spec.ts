/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

//

describe('Comments e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versionId: string;
  let userToken: string;
  let adminToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';

    const book = await prisma.book.create({ data: { slug: `book-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 't',
        author: 'a',
        description: 'd',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    const userEmail = `user_${Date.now()}@example.com`;
    const pass = 'password123';
    const reg = await request(http())
      .post('/auth/register')
      .send({ email: userEmail, password: pass });
    if (reg.status === 201) userToken = reg.body.accessToken as string;
    else
      userToken = (
        await request(http()).post('/auth/login').send({ email: userEmail, password: pass })
      ).body.accessToken as string;

    const adminEmail = 'admin@example.com';
    const regAdmin = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password: pass });
    if (regAdmin.status === 201) adminToken = regAdmin.body.accessToken as string;
    else
      adminToken = (
        await request(http()).post('/auth/login').send({ email: adminEmail, password: pass })
      ).body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('create -> list -> get -> update text (owner) -> moderate (admin) -> delete (owner)', async () => {
    const created = await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ bookVersionId: versionId, text: 'Hello' })
      .expect(201);
    const id = created.body.id as string;

    const list1 = await request(http())
      .get(`/comments?target=version&targetId=${versionId}`)
      .expect(200);
    expect(list1.body.items.length).toBeGreaterThan(0);

    await request(http()).get(`/comments/${id}`).expect(200);

    await request(http())
      .patch(`/comments/${id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ text: 'Updated' })
      .expect(200);

    await request(http())
      .patch(`/comments/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isHidden: true })
      .expect(200);

    await request(http())
      .delete(`/comments/${id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(204);

    await request(http()).get(`/comments/${id}`).expect(404);
  });

  it('enforces single target constraint', async () => {
    await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ text: 'x' })
      .expect(400);

    // both version and chapter -> 400
    const chapter = await prisma.chapter.create({
      data: { bookVersionId: versionId, number: 1, title: 'c1', content: '...' },
    });
    await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ bookVersionId: versionId, chapterId: chapter.id, text: 'bad' })
      .expect(400);
  });

  it('forbids editing others text; allows admin to delete', async () => {
    const other = await request(http())
      .post('/auth/register')
      .send({ email: `o_${Date.now()}@ex.com`, password: 'password123' });
    const otherToken = other.body.accessToken as string;

    const created = await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ bookVersionId: versionId, text: 'Mine' })
      .expect(201);
    const id = created.body.id as string;

    await request(http())
      .patch(`/comments/${id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ text: 'hack' })
      .expect(403);

    await request(http())
      .delete(`/comments/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
  });
});
