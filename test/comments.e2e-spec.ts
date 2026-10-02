/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

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

    const book = await createBookFixture(prisma, `book-${Date.now()}`);
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

  // `LEGACY-366`: третьего уровня нет — ответ на ответ встаёт под корень ветки.
  describe('глубина ветки (LEGACY-366)', () => {
    const post = (body: Record<string, string>) =>
      request(http()).post('/comments').set('Authorization', `Bearer ${userToken}`).send(body);

    it('ответ на ответ крепится к корню ветки', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Root' }).expect(201);
      const reply = await post({
        bookVersionId: versionId,
        parentId: root.body.id as string,
        text: 'Reply',
      }).expect(201);
      const nested = await post({
        bookVersionId: versionId,
        parentId: reply.body.id as string,
        text: 'Reply to reply',
      }).expect(201);

      expect(nested.body.parentId).toBe(root.body.id);
    });

    it('ответ в старой цепочке глубже двух встаёт под самый корень', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Old root' }).expect(201);
      const userId = root.body.userId as string;
      // Цепочка R→C→Q, записанная до правки: API её больше не создаёт.
      const c = await prisma.comment.create({
        data: { userId, bookVersionId: versionId, parentId: root.body.id as string, text: 'C' },
      });
      const q = await prisma.comment.create({
        data: { userId, bookVersionId: versionId, parentId: c.id, text: 'Q' },
      });

      const answer = await post({ bookVersionId: versionId, parentId: q.id, text: 'A' }).expect(
        201,
      );

      expect(answer.body.parentId).toBe(root.body.id);
    });

    const hide = (id: string) =>
      request(http())
        .patch(`/comments/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isHidden: true })
        .expect(200);

    it('скрытый корень: чужой ответ — 404, автор корня отвечает под корень', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Hidden root' }).expect(201);
      const rootId = root.body.id as string;
      const c = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bookVersionId: versionId, parentId: rootId, text: 'Visible C' })
        .expect(201);
      await hide(rootId);

      const other = await request(http())
        .post('/auth/register')
        .send({ email: `h_${Date.now()}@ex.com`, password: 'password123' })
        .expect(201);
      await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${other.body.accessToken as string}`)
        .send({ bookVersionId: versionId, parentId: c.body.id as string, text: 'Q' })
        .expect(404);

      const own = await post({
        bookVersionId: versionId,
        parentId: c.body.id as string,
        text: 'Own Q',
      }).expect(201);
      expect(own.body.parentId).toBe(rootId);
    });

    it('скрытый ответ при видимом корне — ответ встаёт под корень', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Visible root' }).expect(201);
      const c = await post({
        bookVersionId: versionId,
        parentId: root.body.id as string,
        text: 'C',
      }).expect(201);
      await hide(c.body.id as string);

      const answer = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bookVersionId: versionId, parentId: c.body.id as string, text: 'Mod' })
        .expect(201);
      expect(answer.body.parentId).toBe(root.body.id);
    });
  });

  // `LEGACY-428`: цель и оценка ответа — от ветки; корень запирается в транзакции записи.
  describe('ответ сверяется с веткой (LEGACY-428)', () => {
    const post = (body: Record<string, unknown>, token = userToken) =>
      request(http()).post('/comments').set('Authorization', `Bearer ${token}`).send(body);

    it('ответ с оценкой — 400, оценка книги не меняется', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Rated', rating: 5 }).expect(201);
      await post({
        bookVersionId: versionId,
        parentId: root.body.id as string,
        text: 'Reply',
        rating: 1,
      })
        .expect(400)
        .expect(({ body }) => expect(body.message).toBe('Rating cannot be attached to a reply'));
      const again = await request(http())
        .get(`/comments/${root.body.id as string}`)
        .expect(200);
      expect(again.body.ratingScore).toBe(5);
    });

    it('цель ответа отличается от цели корня — 400', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Root' }).expect(201);
      const chapter = await prisma.chapter.create({
        data: { bookVersionId: versionId, number: 900, title: 'c', content: '...' },
      });
      await post({ chapterId: chapter.id, parentId: root.body.id as string, text: 'R' })
        .expect(400)
        .expect(({ body }) =>
          expect(body.message).toBe('Reply target must match the thread root target'),
        );
    });

    it('ветка главы и аудиоглавы: ответ с той же целью — 201 под корень', async () => {
      const chapter = await prisma.chapter.create({
        data: { bookVersionId: versionId, number: 901, title: 'c', content: '...' },
      });
      const audio = await prisma.audioChapter.create({
        data: {
          bookVersionId: versionId,
          number: 901,
          title: 'a',
          audioUrl: 'https://example.com/a.mp3',
          duration: 60,
        },
      });
      for (const target of [{ chapterId: chapter.id }, { audioChapterId: audio.id }]) {
        const root = await post({ ...target, text: 'Root' }).expect(201);
        const answer = await post({
          ...target,
          parentId: root.body.id as string,
          text: 'Reply',
        }).expect(201);
        expect(answer.body.parentId).toBe(root.body.id);
      }
    });

    /**
     * Живая гонка: модератор скрывает корень в открытой транзакции, ответ приходит,
     * пока она не закоммичена. Проверка вне транзакции видит корень видимым; без
     * замка вставка проходит мимо (внешний ключ берёт `FOR KEY SHARE`, он со
     * скрытием не конфликтует) и ответ ложится под скрытый корень. С замком
     * ответ ждёт коммита скрытия и получает 404.
     */
    it('корень скрыт между проверкой и записью — ответ ждёт и получает 404', async () => {
      const root = await post({ bookVersionId: versionId, text: 'Race root' }).expect(201);
      const rootId = root.body.id as string;
      const other = await request(http())
        .post('/auth/register')
        .send({ email: `race_${Date.now()}@ex.com`, password: 'password123' })
        .expect(201);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let holderPid!: number;
      let holderReady!: () => void;
      const ready = new Promise<void>((resolve) => (holderReady = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          const [me] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          holderPid = me.pid;
          await tx.comment.update({ where: { id: rootId }, data: { isHidden: true } });
          holderReady();
          await gate;
        },
        { timeout: 20_000 },
      );
      try {
        await ready;
        // `.then` нужен: supertest шлёт запрос только при подписке на результат, без неё
        // ответ уходит после опроса и гонки нет.
        const replyReq = post(
          { bookVersionId: versionId, parentId: rootId, text: 'Late reply' },
          other.body.accessToken as string,
        ).then((res) => res);

        const until = Date.now() + 10_000;
        let blocked = false;
        while (!blocked && Date.now() < until) {
          const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
          blocked = row.n > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        release();
        await holder;
        const res = await replyReq;

        expect(blocked).toBe(true);
        expect(res.status).toBe(404);
        const children = await prisma.comment.count({ where: { parentId: rootId } });
        expect(children).toBe(0);
      } finally {
        release();
        await holder.catch(() => undefined);
      }
    });
  });

  // `LEGACY-435`: оценка одна на пару «автор — книга», `Comment.ratingId` уникален —
  // второй отзыв с оценкой падал `P2002` и 500. Решение арбитра 02.10.2026: 409,
  // прежняя оценка и её отзыв не меняются; менять оценку — `POST /books/:id/rate`.
  describe('второй отзыв с оценкой (LEGACY-435)', () => {
    const post = (body: Record<string, unknown>) =>
      request(http()).post('/comments').set('Authorization', `Bearer ${userToken}`).send(body);

    // Своя книга на кейс: оценка пары «автор — книга» не должна тянуться между тестами.
    let seq = 0;
    const freshVersion = async () => {
      seq += 1;
      const book = await createBookFixture(prisma, `book-435-${Date.now()}-${seq}`);
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
      return { bookId: book.id, versionId: version.id };
    };

    it('второй корневой отзыв с оценкой — 409, первая оценка и её отзыв на месте', async () => {
      const { bookId, versionId: v } = await freshVersion();
      const first = await post({ bookVersionId: v, text: 'First', rating: 5 }).expect(201);
      await post({ bookVersionId: v, text: 'Second', rating: 2 })
        .expect(409)
        .expect(({ body }) =>
          expect(body.message).toBe('Book rating is already attached to a comment'),
        );

      const ratings = await prisma.bookRating.findMany({ where: { bookId } });
      expect(ratings.map((r) => r.score)).toEqual([5]);
      const again = await request(http())
        .get(`/comments/${first.body.id as string}`)
        .expect(200);
      expect(again.body.ratingScore).toBe(5);
      expect(await prisma.comment.count({ where: { bookVersionId: v } })).toBe(1);
    });

    it('отзыв без оценки после отзыва с оценкой — 201', async () => {
      const { versionId: v } = await freshVersion();
      await post({ bookVersionId: v, text: 'Rated', rating: 4 }).expect(201);
      await post({ bookVersionId: v, text: 'Plain' }).expect(201);
    });

    it('оценка через /rate без отзыва, затем отзыв с оценкой — 201, оценка обновлена', async () => {
      const { bookId, versionId: v } = await freshVersion();
      await request(http())
        .post(`/books/${bookId}/rate`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ score: 4 })
        .expect(200);
      const review = await post({ bookVersionId: v, text: 'Rated later', rating: 2 }).expect(201);
      expect(review.body.ratingScore).toBe(2);
      const ratings = await prisma.bookRating.findMany({ where: { bookId } });
      expect(ratings.map((r) => r.score)).toEqual([2]);
    });

    it('оценку держит ответ, записанный до T79 (LEGACY-428), — тоже 409', async () => {
      const { bookId, versionId: v } = await freshVersion();
      const root = await post({ bookVersionId: v, text: 'Root' }).expect(201);
      const rating = await prisma.bookRating.create({
        data: { userId: root.body.userId as string, bookId, score: 3 },
      });
      await prisma.comment.create({
        data: {
          userId: root.body.userId as string,
          bookVersionId: v,
          parentId: root.body.id as string,
          text: 'Old reply',
          ratingId: rating.id,
        },
      });
      await post({ bookVersionId: v, text: 'Rated root', rating: 1 }).expect(409);
      const kept = await prisma.bookRating.findUniqueOrThrow({ where: { id: rating.id } });
      expect(kept.score).toBe(3);
    });

    it('двойная отправка отзыва с оценкой — один 201 и один 409, без 500', async () => {
      const { bookId, versionId: v } = await freshVersion();
      const results = await Promise.all([
        post({ bookVersionId: v, text: 'A', rating: 5 }),
        post({ bookVersionId: v, text: 'B', rating: 1 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = results.find((r) => r.status === 201);
      const ratings = await prisma.bookRating.findMany({ where: { bookId } });
      expect(ratings.map((r) => r.score)).toEqual([winner?.body.ratingScore]);
    });
  });
});
