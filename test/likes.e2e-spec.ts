/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Likes e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userAccess: string;
  let versionId: string;
  let commentId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await prisma.book.create({ data: { slug: `book-like-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Title',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password }).expect(201);
    userAccess = reg.body.accessToken as string;

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const comment = await prisma.comment.create({
      data: { userId: user.id, bookVersionId: versionId, text: 'Nice!' },
    });
    commentId = comment.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires auth for POST/DELETE /likes', async () => {
    await request(http()).post('/likes').send({ commentId }).expect(401);
    await request(http()).delete('/likes').send({ commentId }).expect(401);
  });

  it('likes and unlikes comment with counts and idempotency', async () => {
    // initial count
    const c0 = await request(http())
      .get(`/likes/count?target=comment&targetId=${commentId}`)
      .expect(200);
    const startCount = c0.body.count as number;

    // like
    await request(http())
      .post('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ commentId })
      .expect(201);

    // duplicate like returns 409 Conflict (idempotency policy)
    await request(http())
      .post('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ commentId })
      .expect(409);

    // count increased at least by 1
    const c1 = await request(http())
      .get(`/likes/count?target=comment&targetId=${commentId}`)
      .expect(200);
    expect((c1.body.count as number) >= startCount + 1).toBe(true);

    // unlike
    await request(http())
      .delete('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ commentId })
      .expect(204);

    // unlike again still 204
    await request(http())
      .delete('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ commentId })
      .expect(204);

    const c2 = await request(http())
      .get(`/likes/count?target=comment&targetId=${commentId}`)
      .expect(200);
    expect(c2.body.count as number).toBeGreaterThanOrEqual(startCount);
  });

  it('likes and unlikes book version', async () => {
    await request(http())
      .post('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ bookVersionId: versionId })
      .expect(201);

    const c = await request(http())
      .get(`/likes/count?target=bookVersion&targetId=${versionId}`)
      .expect(200);
    expect(typeof c.body.count).toBe('number');

    await request(http())
      .delete('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ bookVersionId: versionId })
      .expect(204);
  });

  it('validates exactly one target', async () => {
    await request(http())
      .post('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({})
      .expect(400);

    await request(http())
      .post('/likes')
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ commentId, bookVersionId: versionId })
      .expect(400);
  });
});
