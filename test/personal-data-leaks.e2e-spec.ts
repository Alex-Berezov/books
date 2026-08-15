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
 * `LEGACY-088` / `LEGACY-089`. Две утечки персональных данных, найденные обходом
 * открытых GET-маршрутов 09.08.2026, и связанные между собой:
 *
 * 1. `GET /comments` отдавал анониму `email` каждого комментатора — и его `id`;
 * 2. `reader-bootstrap?userId=<этот id>` отдавал анониму, что человек читает и
 *    на каком месте остановился.
 *
 * ⚠️ Ни одна не закрывается гвардом: и отзывы, и читалка открыты анониму по
 * замыслу. Разделять нужно **ответ**, а не доступ, — поэтому проверяется, что
 * маршрут по-прежнему работает без токена и молчит только о персональном.
 */
describe('Personal data leaks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHashService: RightsContentHashService;

  let adminToken: string;
  let readerToken: string;
  let strangerToken: string;
  let readerId: string;

  let bookSlug: string;
  let versionId: string;

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

    const readerEmail = `reader_${Date.now()}@example.com`;
    readerToken = await registerOrLogin(readerEmail);
    strangerToken = await registerOrLogin(`stranger_${Date.now()}@example.com`);

    const reader = await prisma.user.findUniqueOrThrow({ where: { email: readerEmail } });
    readerId = reader.id;

    bookSlug = `leaks-${Date.now()}`;
    const bookWithRights = await createBookWithRights(prisma, bookSlug);

    const created = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Leaky Title',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    versionId = (created.body as { id: string }).id;

    await request(http())
      .post(`/versions/${versionId}/chapters`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ number: 1, title: 'Chapter 1', content: 'Text' })
      .expect(201);

    await markBookRightsFreshForTests(prisma, bookWithRights.book.id, rightsContentHashService);

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Прогресс чтения принадлежит `reader` — именно его пытается получить чужой.
    await prisma.readingProgress.create({
      data: { userId: readerId, bookVersionId: versionId, chapterNumber: 1, position: 0.42 },
    });
  });

  afterAll(async () => {
    if (bookSlug) {
      await cleanupBookWithRights(prisma, bookSlug);
    }
    await app.close();
  });

  describe('LEGACY-089 — почта комментаторов', () => {
    it('не отдаёт email анониму ни в комментарии, ни в ответе на него', async () => {
      const root = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ bookVersionId: versionId, text: 'Root comment' })
        .expect(201);
      const rootId = (root.body as { id: string }).id;

      await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ parentId: rootId, bookVersionId: versionId, text: 'Reply' })
        .expect(201);

      const list = await request(http())
        .get(`/comments?target=version&targetId=${versionId}`)
        .expect(200);

      // 🔴 Проверяется весь ответ целиком, а не отдельные поля: селект
      // повторялся в шести местах, и ветка ответов забывалась отдельно от
      // ветки корневых комментариев.
      expect(JSON.stringify(list.body)).not.toContain('@example.com');

      const items = (list.body as { items: { user: Record<string, unknown> }[] }).items;
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].user).not.toHaveProperty('email');

      // Отзывы обязаны остаться читаемыми без входа — лечится ответ, не доступ.
      expect(items[0].user).toHaveProperty('id');
    });

    it('не отдаёт email анониму и на одиночном комментарии', async () => {
      const created = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ bookVersionId: versionId, text: 'Single' })
        .expect(201);
      const id = (created.body as { id: string }).id;

      const one = await request(http()).get(`/comments/${id}`).expect(200);
      expect(one.body).toHaveProperty('user');
      expect((one.body as { user: Record<string, unknown> }).user).not.toHaveProperty('email');
    });
  });

  describe('LEGACY-089 — скрытые комментарии', () => {
    it('скрытый комментарий не читается по прямой ссылке, но виден модератору', async () => {
      const created = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ bookVersionId: versionId, text: 'To be hidden' })
        .expect(201);
      const id = (created.body as { id: string }).id;

      await request(http())
        .patch(`/comments/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isHidden: true })
        .expect(200);

      // 🔴 Адрес не секрет: он приходит в ответе на создание и лежит в истории
      // браузера. Сокрытие, которое держится на незнании ссылки, — не сокрытие.
      await request(http()).get(`/comments/${id}`).expect(404);

      // Модератор обязан видеть скрытое, иначе модерирует вслепую.
      await request(http())
        .get(`/comments/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('скрытый ответ исчезает из публичной ветки', async () => {
      const root = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ bookVersionId: versionId, text: 'Thread root' })
        .expect(201);
      const rootId = (root.body as { id: string }).id;

      const reply = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ parentId: rootId, bookVersionId: versionId, text: 'Hidden reply text' })
        .expect(201);

      await request(http())
        .patch(`/comments/${(reply.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isHidden: true })
        .expect(200);

      // 🔴 Корневые комментарии отсекались правильно, ответы — нет: сокрытие
      // работало ровно до первого ответа в ветке.
      const list = await request(http())
        .get(`/comments?target=version&targetId=${versionId}`)
        .expect(200);
      expect(JSON.stringify(list.body)).not.toContain('Hidden reply text');
    });
  });

  /**
   * `LEGACY-210`. То же сокрытие, но на собственной странице активности:
   * `GET /users/me/activities` знал только про `isDeleted`, и то, что убрано
   * из публичной ветки, оставалось видно автору ветки — с текстом и с личностью
   * написавшего. Владелец страницы модератором не является, значит ветка ему
   * положена в том же виде, что анониму.
   *
   * ⚠️ Проверяется живое тело ответа, а не аргументы запроса: юнит-посадка
   * в `users.service.spec.ts` смотрит на `where`, и подмена маппера ею
   * не ловится.
   */
  describe('LEGACY-210 — скрытые ответы в активности', () => {
    it('скрытый ответ не приходит в GET /users/me/activities', async () => {
      const root = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ bookVersionId: versionId, text: 'Activity thread root' })
        .expect(201);

      const reply = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({
          parentId: (root.body as { id: string }).id,
          bookVersionId: versionId,
          text: 'Hidden activity reply text',
        })
        .expect(201);

      await request(http())
        .patch(`/comments/${(reply.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isHidden: true })
        .expect(200);

      const activities = await request(http())
        .get('/users/me/activities')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200);

      const body = JSON.stringify(activities.body);
      // Ответ целиком: вместе с текстом уезжали `id`, `name`, `nickname`
      // и `avatarUrl` того, кого скрыли, — ровно та выдача личности, которую
      // закрывала `LEGACY-089`.
      expect(body).not.toContain('Hidden activity reply text');
      // 🔴 Положительный контроль обязателен: на одних отрицаниях маршрут,
      // отдавший пустой список по любой причине, прошёл бы зелёным, и тест
      // не отличал бы «скрытое отфильтровано» от «не пришло ничего».
      expect(body).toContain('Activity thread root');
    });

    it('запись со скрытым родителем не приходит вовсе — как и с удалённым', async () => {
      const root = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ bookVersionId: versionId, text: 'Hidden activity parent text' })
        .expect(201);

      await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({
          parentId: (root.body as { id: string }).id,
          bookVersionId: versionId,
          text: 'Reply under hidden parent',
        })
        .expect(201);

      // Ответ под видимым родителем — положительный контроль: он обязан
      // остаться в активности, иначе тест не отличает фильтр от пустого ответа.
      const visibleRoot = await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ bookVersionId: versionId, text: 'Visible activity parent text' })
        .expect(201);

      await request(http())
        .post('/comments')
        .set('Authorization', `Bearer ${readerToken}`)
        .send({
          parentId: (visibleRoot.body as { id: string }).id,
          bookVersionId: versionId,
          text: 'Reply under visible parent',
        })
        .expect(201);

      await request(http())
        .patch(`/comments/${(root.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isHidden: true })
        .expect(200);

      const activities = await request(http())
        .get('/users/me/activities')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200);

      const body = JSON.stringify(activities.body);
      expect(body).not.toContain('Hidden activity parent text');
      expect(body).not.toContain('Reply under hidden parent');
      expect(body).toContain('Reply under visible parent');
    });
  });

  describe('LEGACY-088 — чужой прогресс чтения', () => {
    it('игнорирует userId в query: подставить чужой идентификатор больше нечем', async () => {
      const res = await request(http())
        .get(`/en/books/${bookSlug}/reader-bootstrap?userId=${readerId}`)
        .expect(200);

      // Книга открывается, персональной части нет.
      expect((res.body as { versionId: string }).versionId).toBe(versionId);
      expect((res.body as { lastProgress: unknown }).lastProgress).toBeNull();
    });

    it('отдаёт прогресс владельцу токена и молчит чужому', async () => {
      const owner = await request(http())
        .get(`/en/books/${bookSlug}/reader-bootstrap`)
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200);
      expect((owner.body as { lastProgress: { position: number } }).lastProgress.position).toBe(
        0.42,
      );

      const stranger = await request(http())
        .get(`/en/books/${bookSlug}/reader-bootstrap`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .expect(200);
      expect((stranger.body as { lastProgress: unknown }).lastProgress).toBeNull();
    });

    it('отвечает 401 на присланный, но негодный токен', async () => {
      // Молчаливая деградация «плохой токен = аноним» вернула бы 200 без
      // прогресса, и протухшая сессия выглядела бы как потеря места в книге.
      await request(http())
        .get(`/en/books/${bookSlug}/reader-bootstrap`)
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
    });

    it('запрещает общим кэшам хранить персональный ответ', async () => {
      // 🔴 Ключевая связка: без query-параметра URL стал одинаковым для всех.
      // Пока на маршруте висел `public, s-maxage=300`, унаследованный от
      // контроллера, один shared-кэш раздал бы прогресс первого читателя всем
      // остальным — то есть перенос в токен без этой правки делает хуже.
      const personal = await request(http())
        .get(`/en/books/${bookSlug}/reader-bootstrap`)
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(200);
      expect(personal.headers['cache-control']).toBe('private, no-store');

      // Соседний неперсональный маршрут того же контроллера кэш не теряет.
      const shared = await request(http()).get('/en/books/cards?limit=1').expect(200);
      expect(shared.headers['cache-control']).toContain('public');
    });
  });
});
