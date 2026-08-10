import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookType, Language } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { markBookRightsFreshForTests } from './helpers/rights-fresh';
import { httpServerOf } from './http-server';

/**
 * `LEGACY-092`. Админский раздел комментариев был написан против API, которого
 * не существует: `GET /comments?page=…` отвечал 400, `PATCH /comments/:id/status`
 * и `POST /comments/:id/reply` — 404. Модерация отзывов не работала вовсе, а сам
 * мёртвый код при этом числился блокером в `LEGACY-089`.
 *
 * ⚠️ Отдельный маршрут, а не параметры к публичному листингу: тот отвечает на
 * вопрос «что показать под этой книгой» и обязан требовать `target`/`targetId`.
 */
describe('Admin comments moderation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHashService: RightsContentHashService;

  let adminToken: string;
  let readerToken: string;
  let bookSlug: string;
  let versionId: string;
  let commentId: string;

  const http = () => httpServerOf(app);

  const registerOrLogin = async (email: string, password = 'password123'): Promise<string> => {
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return (reg.body as { accessToken: string }).accessToken;
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return (login.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    rightsContentHashService = moduleRef.get(RightsContentHashService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    adminToken = await registerOrLogin('admin@example.com');
    readerToken = await registerOrLogin(`moder_reader_${Date.now()}@example.com`);

    bookSlug = `moderation-${Date.now()}`;
    const bookWithRights = await createBookWithRights(prisma, bookSlug);

    const created = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Moderated Book',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    versionId = (created.body as { id: string }).id;

    await markBookRightsFreshForTests(prisma, bookWithRights.book.id, rightsContentHashService);
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const comment = await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${readerToken}`)
      .send({ bookVersionId: versionId, text: 'Needs moderation' })
      .expect(201);
    commentId = (comment.body as { id: string }).id;
  });

  afterAll(async () => {
    if (bookSlug) {
      await cleanupBookWithRights(prisma, bookSlug);
    }
    await app.close();
  });

  it('закрыт для анонима и обычного пользователя', async () => {
    await request(http()).get('/admin/comments').expect(401);
    await request(http())
      .get('/admin/comments')
      .set('Authorization', `Bearer ${readerToken}`)
      .expect(403);
  });

  /**
   * 🔴 Тот самый запрос, который раньше отвечал 400: модерации нужен список
   * всех комментариев сайта, а не выборка по одной цели.
   */
  it('отдаёт плоский список без указания цели', async () => {
    const res = await request(http())
      .get('/admin/comments?page=1&limit=20')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as {
      data: { id: string; text: string; author: { email: string }; bookVersionId: string }[];
      meta: { total: number; totalPages: number };
    };
    const mine = body.data.find((c) => c.id === commentId);
    expect(mine).toBeDefined();
    expect(mine?.text).toBe('Needs moderation');
    // Почта здесь уместна: маршрут под гвардом, модератору нужно отличать людей.
    expect(mine?.author.email).toContain('@example.com');
    // Без цели ответить нельзя — создание комментария требует её, а не parentId.
    expect(mine?.bookVersionId).toBe(versionId);
    expect(body.meta.total).toBeGreaterThan(0);
  });

  it('фильтрует по статусу и находит по подстроке', async () => {
    await request(http())
      .patch(`/comments/${commentId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isHidden: true })
      .expect(200);

    const hidden = await request(http())
      .get('/admin/comments?status=hidden&limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((hidden.body as { data: { id: string }[] }).data.map((c) => c.id)).toContain(commentId);

    const visible = await request(http())
      .get('/admin/comments?status=visible&limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((visible.body as { data: { id: string }[] }).data.map((c) => c.id)).not.toContain(
      commentId,
    );

    const found = await request(http())
      .get('/admin/comments?search=Needs%20moderation&limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((found.body as { data: { id: string }[] }).data.map((c) => c.id)).toContain(commentId);

    // Возврат в исходное состояние — модерация обратима.
    await request(http())
      .patch(`/comments/${commentId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isHidden: false })
      .expect(200);
  });

  // Ответ модератора — обычный комментарий с parentId, отдельного маршрута нет.
  it('позволяет ответить на комментарий', async () => {
    const reply = await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parentId: commentId, bookVersionId: versionId, text: 'Moderator reply' })
      .expect(201);

    expect((reply.body as { parentId: string }).parentId).toBe(commentId);

    const list = await request(http())
      .get('/admin/comments?limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const parent = (list.body as { data: { id: string; repliesCount: number }[] }).data.find(
      (c) => c.id === commentId,
    );
    expect(parent?.repliesCount).toBe(1);
  });

  /**
   * ⚠️ Потолок задан сразу: админские списки без него в этом проекте уже
   * встречались (`LEGACY-076`), и позже добавить дороже — к тому времени
   * появляются потребители, просящие `limit=1000`.
   */
  it('отвергает limit сверх потолка', async () => {
    await request(http())
      .get('/admin/comments?limit=1000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('удалённые комментарии в список не попадают', async () => {
    const doomed = await request(http())
      .post('/comments')
      .set('Authorization', `Bearer ${readerToken}`)
      .send({ bookVersionId: versionId, text: 'To be deleted' })
      .expect(201);

    await request(http())
      .delete(`/comments/${(doomed.body as { id: string }).id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const list = await request(http())
      .get('/admin/comments?limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain('To be deleted');
  });
});
