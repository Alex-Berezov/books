/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- тело ответа supertest типизировано как any */
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmStageRegistry } from '../src/modules/llm/llm-stages.registry';
import { LlmTaskHandlerRegistry } from '../src/modules/llm-worker/llm-task-handler.registry';
import { LlmTaskService } from '../src/modules/llm-worker/llm-task.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { WorldMentionsSchedulerService } from '../src/modules/book-world/world-mentions-scheduler.service';
import { httpServerOf } from './http-server';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F08-11a, F08-11d-1: иллюстрация героя без генерации (решение владельца: сайт картинки
 * не генерирует; решения арбитра `F08 | F08-11d` Q7, Q9, Q10). Ручки запуска генерации нет -
 * 404 и ни одного внешнего запроса; ожидающая ячейка заводится прямо в базе; непринятая
 * не отдаётся публично; принятая до снятия картинка на сайте как была (U8); 403 всем, кроме admin;
 * задачи `world_image`, оставшиеся от генерации, закрываются без вызова модели.
 */
describe('World image e2e (F08-11a, F08-11d-1, F08-11d-3: file upload)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let app: INestApplication;
  let db: PrismaService;
  let worker: LlmWorkerService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);
  const path = (versionId: string, key = 'oblomov') =>
    `/admin/versions/${versionId}/world/${key}/image`;
  const publicEntity = (versionId: string, key = 'oblomov') =>
    http().get(`/versions/${versionId}/world/${key}`).expect(200);

  const resetBudget = () =>
    db.llmBudget.upsert({
      where: { id: LLM_BUDGET_ID },
      create: { id: LLM_BUDGET_ID, ceilingUsd: 100, defaultRunLimitUsd: 10 },
      update: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0, defaultRunLimitUsd: 10 },
    });

  /** Опубликованная версия книги и герой на сайте (`isListed` - как его ставит запись мира). */
  const version = async (
    bookId: string,
    language: Language,
    hero: { role?: string; appearance?: string | null; type?: 'character' | 'place' } = {},
  ) => {
    const v = await db.bookVersion.create({
      data: {
        bookId,
        language,
        title: 'Oblomov',
        author: 'Goncharov',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
      },
    });
    await db.bookWorldEntity.create({
      data: {
        bookVersionId: v.id,
        key: 'oblomov',
        type: hero.type ?? 'character',
        name: 'Ilya Oblomov',
        // Место (`F08-12c-2`): тот же ключ - другая сущность другой версии книги.
        role: hero.type === 'place' ? null : (hero.role ?? 'main'),
        blocks:
          hero.type === 'place'
            ? { kind: 'fictional', description: 'Grey boards and tarred rope.' }
            : hero.appearance === null
              ? {}
              : { appearance: hero.appearance ?? 'A plump man of about thirty-two.' },
        hasCore: true,
        isListed: true,
        readAt: new Date(),
      },
    });
    return v.id;
  };

  const book = async () =>
    (await createBookFixture(db, `world-image-${stamp}-${Math.random().toString(36).slice(2, 6)}`))
      .id;

  const asset = (width = 1536, height = 1536) => {
    const key = `illustrations/2026/11/24/${randomUUID()}.png`;
    return db.mediaAsset.create({
      data: {
        key,
        url: `https://media.example.com/${key}`,
        contentType: 'image/png',
        size: 1024,
        width,
        height,
      },
    });
  };

  /** Ячейки строки картинки прямо в базе (подготовка состояния до загрузки или «Accept»). */
  const imageRow = async (
    bookId: string,
    cells: { pendingMediaId?: string; imageMediaId?: string; imageReadAt?: Date },
  ) => db.bookWorldImage.create({ data: { bookId, key: 'oblomov', ...cells } });

  const externalCalls = (): unknown[][] =>
    (fetchSpy.mock.calls as unknown[][]).filter(([input]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      return !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost');
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    db = app.get(PrismaService);
    worker = app.get(LlmWorkerService);
    await app.get(WorldMentionsSchedulerService).onModuleDestroy();
    const emails = {
      admin: `f0811-admin-${stamp}@test.com`,
      cm: `f0811-cm-${stamp}@test.com`,
      user: `f0811-user-${stamp}@test.com`,
    };
    for (const email of Object.values(emails)) {
      await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
    }
    await grantStaffRoles(app, emails.admin);
    await grantStaffRoles(app, emails.cm, [RoleName.content_manager]);
    for (const who of ['admin', 'cm', 'user'] as const) {
      const res = await http()
        .post('/auth/login')
        .send({ email: emails[who], password: 'password123' })
        .expect(200);
      tokens[who] = (res.body as { accessToken: string }).accessToken;
    }
  });

  beforeEach(async () => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    await resetBudget();
    // Любой внешний запрос - отказ и след в шпионе: генерации нет, в сеть ходить некому.
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('unexpected fetch')));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    process.env.OPENROUTER_API_KEY = '';
    // Только свои хвосты: база одна на воркер jest, задачи соседних сьютов не трогаем.
    await db.llmTask.updateMany({
      where: { kind: 'world_image', status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('access: GET and accept are admin only; no token - 401', async () => {
    const versionId = await version(await book(), Language.en);
    for (const [method, url] of [
      ['get', path(versionId)],
      ['post', `${path(versionId)}/accept`],
    ] as Array<['get' | 'post', string]>) {
      await http()[method](url).expect(401);
      await auth(http()[method](url), 'cm').expect(403);
      await auth(http()[method](url), 'user').expect(403);
    }
  });

  /** PNG из одного заголовка: сигнатура и IHDR хватает `sniffImage`. */
  const pngBytes = (width: number, height: number): Buffer => {
    const b = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  };
  const send = (versionId: string, bytes: Buffer, who: 'admin' | 'cm' | 'user' = 'admin') =>
    auth(http().post(path(versionId)), who).attach('file', bytes, 'portrait.png');

  it('upload (F08-11d-3): the file goes to the pending cell only; nothing is generated, no external call', async () => {
    const bookId = await book();
    const versionId = await version(bookId, Language.en);
    const opsBefore = await db.llmOperation.count({ where: { bookVersionId: versionId } });
    const res = await send(versionId, pngBytes(1536, 1536)).expect(200);
    expect(res.body.accepted).toBeNull();
    expect(res.body.pending).toMatchObject({ width: 1536, height: 1536 });
    // Автор файла - пользователь из токена (`req.user.userId`), а не пусто.
    const stored = await db.mediaAsset.findUniqueOrThrow({
      where: { id: res.body.pending.mediaId },
      select: { createdById: true, key: true },
    });
    const admin = await db.user.findUniqueOrThrow({
      where: { email: `f0811-admin-${stamp}@test.com` },
      select: { id: true },
    });
    expect(stored.createdById).toBe(admin.id);
    expect(stored.key).toMatch(/^illustrations[/]/);
    expect((await publicEntity(versionId)).body.image).toBeNull();
    expect(await db.llmOperation.count({ where: { bookVersionId: versionId } })).toBe(opsBefore);
    expect(await db.llmTask.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(externalCalls()).toHaveLength(0);
  });

  it('upload: only admin; a refused file is 400 with its code; a minor character is 409', async () => {
    const bookId = await book();
    const versionId = await version(bookId, Language.en);
    await http().post(path(versionId)).attach('file', pngBytes(1536, 1536), 'p.png').expect(401);
    for (const who of ['cm', 'user'] as const) {
      await send(versionId, pngBytes(1536, 1536), who).expect(403);
    }
    const assetsBefore = await db.mediaAsset.count();
    const small = await send(versionId, pngBytes(1200, 800)).expect(400);
    expect(small.body.code).toBe('WORLD_IMAGE_TOO_SMALL');
    const text = await send(versionId, Buffer.from('<svg></svg>'.padEnd(64))).expect(400);
    expect(text.body.code).toBe('WORLD_IMAGE_NOT_IMAGE');
    // Файл больше 12 МБ отбивает разбор формы - тем же кодом, что и проверка байтов.
    const huge = Buffer.concat([pngBytes(1536, 1536), Buffer.alloc(12 * 1024 * 1024)]);
    const large = await send(versionId, huge).expect(413);
    expect(large.body.code).toBe('WORLD_IMAGE_TOO_LARGE');
    await auth(http().post(path(versionId))).expect(400);
    await send(versionId, pngBytes(1536, 1536)).expect(200);
    expect(await db.mediaAsset.count()).toBe(assetsBefore + 1);
    await auth(http().post(path(versionId, 'no-such-hero')))
      .attach('file', pngBytes(1536, 1536), 'p.png')
      .expect(404);
    const minorBook = await book();
    const minorVersion = await version(minorBook, Language.en, { role: 'minor' });
    const minor = await send(minorVersion, pngBytes(1536, 1536)).expect(409);
    expect(minor.body.code).toBe('WORLD_IMAGE_NOT_ALLOWED');
  });

  // Решение арбитра `F08 | F08-12c-2`: ключ один на книгу, тип у версий разный - картинка не подменяется.
  it('a place image (F08-12c-2): 16:9 from 1200x675, its own type on the shared key, no swap with a hero of another version', async () => {
    const bookId = await book();
    const placeVersion = await version(bookId, Language.en, { type: 'place' });
    const heroVersion = await version(bookId, Language.ru);

    const small = await send(placeVersion, pngBytes(1200, 674)).expect(400);
    expect(small.body.code).toBe('WORLD_IMAGE_TOO_SMALL');
    const uploaded = (await send(placeVersion, pngBytes(1200, 675)).expect(200)).body as {
      allowed: boolean;
      pending: { mediaId: string } | null;
    };
    expect(uploaded.allowed).toBe(true);
    expect(uploaded.pending).not.toBeNull();
    const pendingId = uploaded.pending?.mediaId ?? '';
    await auth(http().post(`${path(placeVersion)}/accept`))
      .send({ pendingMediaId: pendingId })
      .expect(200);
    expect(
      await db.bookWorldImage.findUnique({ where: { bookId_key: { bookId, key: 'oblomov' } } }),
    ).toMatchObject({ entityType: 'place', imageMediaId: pendingId });

    // Картинка места - на странице места; герою другой версии на том же ключе её нет.
    expect((await publicEntity(placeVersion)).body.image).toMatchObject({
      width: 1200,
      height: 675,
    });
    expect((await publicEntity(heroVersion)).body.image).toBeNull();
    expect((await auth(http().get(path(heroVersion))).expect(200)).body).toMatchObject({
      allowed: true,
      accepted: null,
      pending: null,
      keyConflict: true,
    });
    // Загрузка героя поверх строки места - 409 до записи, строка места цела.
    const assetsBefore = await db.mediaAsset.count();
    const conflict = await send(heroVersion, pngBytes(1536, 1536)).expect(409);
    expect(conflict.body.code).toBe('WORLD_IMAGE_KEY_CONFLICT');
    expect(await db.mediaAsset.count()).toBe(assetsBefore);
    expect(
      await db.bookWorldImage.findUnique({ where: { bookId_key: { bookId, key: 'oblomov' } } }),
    ).toMatchObject({ entityType: 'place', imageMediaId: pendingId, pendingMediaId: null });
  });

  it('a hero portrait is not shown on a place of another version; an empty row moves to the new type (F08-12c-2)', async () => {
    const bookId = await book();
    const heroVersion = await version(bookId, Language.en);
    const placeVersion = await version(bookId, Language.ru, { type: 'place' });
    const portrait = await asset();
    await imageRow(bookId, { imageMediaId: portrait.id, imageReadAt: new Date() });
    expect((await publicEntity(heroVersion)).body.image).toMatchObject({ url: portrait.url });
    expect((await publicEntity(placeVersion)).body.image).toBeNull();
    // Панель места заранее знает, что ключ занят живым портретом героя с правом (круг 1 Q2).
    expect((await auth(http().get(path(placeVersion))).expect(200)).body).toMatchObject({
      allowed: true,
      accepted: null,
      pending: null,
      keyConflict: true,
    });
    const conflict = await send(placeVersion, pngBytes(1600, 900)).expect(409);
    expect(conflict.body.code).toBe('WORLD_IMAGE_KEY_CONFLICT');

    // Пустая строка героя (ни принятой, ни ожидающей) переходит месту под замком.
    const other = await book();
    await version(other, Language.en);
    const otherPlace = await version(other, Language.ru, { type: 'place' });
    await imageRow(other, {});
    await send(otherPlace, pngBytes(1600, 900)).expect(200);
    expect(
      await db.bookWorldImage.findUnique({
        where: { bookId_key: { bookId: other, key: 'oblomov' } },
      }),
    ).toMatchObject({ entityType: 'place' });
  });

  // Решение `F08 | F08-12c-2` круг 1 Q1: ключ не запирается навсегда - смена типа в единственной версии
  // и мёртвый файл чужого типа освобождают строку, её ячейки очищаются.
  it('the key is freed (F08-12c-2 circle 1 Q1): a type change in the only version and a deleted file of another type', async () => {
    const single = await book();
    const singleVersion = await version(single, Language.en, { type: 'place' });
    const portrait = await asset();
    await imageRow(single, { imageMediaId: portrait.id, imageReadAt: new Date() });
    expect((await auth(http().get(path(singleVersion))).expect(200)).body).toMatchObject({
      keyConflict: false,
      accepted: null,
    });
    const uploaded = (await send(singleVersion, pngBytes(1600, 900)).expect(200)).body as {
      accepted: unknown;
      pending: { mediaId: string } | null;
    };
    expect(uploaded.accepted).toBeNull();
    expect(
      await db.bookWorldImage.findUnique({
        where: { bookId_key: { bookId: single, key: 'oblomov' } },
      }),
    ).toMatchObject({
      entityType: 'place',
      imageMediaId: null,
      imageReadAt: null,
      pendingMediaId: uploaded.pending?.mediaId,
    });
    expect((await publicEntity(singleVersion)).body.image).toBeNull();

    const deletedBook = await book();
    await version(deletedBook, Language.en);
    const deletedPlace = await version(deletedBook, Language.ru, { type: 'place' });
    const deleted = await asset();
    await db.mediaAsset.update({ where: { id: deleted.id }, data: { isDeleted: true } });
    await imageRow(deletedBook, { imageMediaId: deleted.id, imageReadAt: new Date() });
    await send(deletedPlace, pngBytes(1600, 900)).expect(200);
    expect(
      await db.bookWorldImage.findUnique({
        where: { bookId_key: { bookId: deletedBook, key: 'oblomov' } },
      }),
    ).toMatchObject({ entityType: 'place', imageMediaId: null });
  });

  it('upload over an accepted image: the accepted one stays on the site until Accept, the new file replaces the pending one', async () => {
    const bookId = await book();
    const versionId = await version(bookId, Language.en);
    const old = await asset();
    const oldPending = await asset();
    await imageRow(bookId, {
      imageMediaId: old.id,
      imageReadAt: new Date('2026-11-23T10:00:00Z'),
      pendingMediaId: oldPending.id,
    });
    const uploaded = (await send(versionId, pngBytes(2048, 2048)).expect(200)).body;
    expect(uploaded.accepted.mediaId).toBe(old.id);
    expect(uploaded.pending).toMatchObject({ width: 2048, height: 2048 });
    expect(uploaded.pending.mediaId).not.toBe(oldPending.id);
    expect((await publicEntity(versionId)).body.image).toEqual({
      url: old.url,
      width: 1536,
      height: 1536,
    });
    await auth(http().post(`${path(versionId)}/accept`))
      .send({ pendingMediaId: uploaded.pending.mediaId })
      .expect(200);
    expect((await publicEntity(versionId)).body.image).toMatchObject({ width: 2048, height: 2048 });
  });

  it('a pending image is not public until accepted, then on every language of the book; the state has no generation fields', async () => {
    const bookId = await book();
    const en = await version(bookId, Language.en);
    const ru = await version(bookId, Language.ru);
    const pending = await asset();
    await imageRow(bookId, { pendingMediaId: pending.id });

    const waiting = (await auth(http().get(path(en))).expect(200)).body;
    expect(waiting).toEqual({
      key: 'oblomov',
      allowed: true,
      roleAllowed: true,
      accepted: null,
      acceptedAt: null,
      pending: { mediaId: pending.id, url: pending.url, width: 1536, height: 1536 },
      keyConflict: false,
    });

    // Непринятая: ни читателю, ни редактору на странице сущности.
    expect((await publicEntity(en)).body.image).toBeNull();
    expect(
      (await auth(http().get(`/versions/${en}/world/oblomov`)).expect(200)).body.image,
    ).toBeNull();

    // Accept чужой картинки - 409; своей - картинка на сайте у обоих языков книги.
    expect(
      (
        await auth(http().post(`${path(en)}/accept`))
          .send({ pendingMediaId: '00000000-0000-4000-8000-000000000000' })
          .expect(409)
      ).body.code,
    ).toBe('WORLD_IMAGE_CHANGED');
    await auth(http().post(`${path(en)}/accept`))
      .send({ pendingMediaId: pending.id })
      .expect(200);
    const accepted = { url: pending.url, width: 1536, height: 1536 };
    expect((await publicEntity(en)).body.image).toEqual(accepted);
    expect((await publicEntity(ru)).body.image).toEqual(accepted);

    // Принимать больше нечего - 409.
    expect(
      (
        await auth(http().post(`${path(ru)}/accept`))
          .send({ pendingMediaId: pending.id })
          .expect(409)
      ).body.code,
    ).toBe('WORLD_IMAGE_NONE');
    expect(externalCalls()).toHaveLength(0);
  });

  it('an image accepted before the removal is still shown on the site (U8); only the accepted cell goes out', async () => {
    const bookId = await book();
    const versionId = await version(bookId, Language.en);
    const old = await asset();
    const waiting = await asset(1600, 1600);
    await imageRow(bookId, {
      imageMediaId: old.id,
      imageReadAt: new Date('2026-11-23T10:00:00Z'),
      pendingMediaId: waiting.id,
    });
    const page = (await publicEntity(versionId)).body as Record<string, unknown>;
    expect(page.image).toEqual({ url: old.url, width: 1536, height: 1536 });
    // `map` - малая карта места (F08-12d); у героя её нет.
    expect(Object.keys(page).sort()).toEqual(
      ['alternates', 'chapterNumbers', 'entity', 'image', 'language', 'map'].sort(),
    );
    expect(page.map).toBeNull();
    expect((await auth(http().get(path(versionId))).expect(200)).body).toMatchObject({
      accepted: { mediaId: old.id },
      pending: { mediaId: waiting.id },
    });
  });

  it('allowed is the role alone (Q10): a hero without appearance may have one; a minor one may not, accept refuses; an unknown key - 404', async () => {
    const bookId = await book();
    const noAppearance = await version(bookId, Language.en, { appearance: null });
    expect((await auth(http().get(path(noAppearance))).expect(200)).body).toMatchObject({
      allowed: true,
      roleAllowed: true,
    });

    const minorBook = await book();
    const minor = await version(minorBook, Language.en, { role: 'minor' });
    const pending = await asset();
    await imageRow(minorBook, { pendingMediaId: pending.id });
    expect((await auth(http().get(path(minor))).expect(200)).body).toMatchObject({
      allowed: false,
      roleAllowed: false,
    });
    expect(
      (
        await auth(http().post(`${path(minor)}/accept`))
          .send({ pendingMediaId: pending.id })
          .expect(409)
      ).body.code,
    ).toBe('WORLD_IMAGE_NOT_ALLOWED');
    await auth(http().get(path(minor, 'nobody'))).expect(404);
  });

  it('accept body and path are validated: not a uuid - 400, an extra field - 400', async () => {
    const versionId = await version(await book(), Language.en);
    await auth(http().post(`${path(versionId)}/accept`))
      .send({ pendingMediaId: 'x' })
      .expect(400);
    await auth(http().post(`${path(versionId)}/accept`))
      .send({})
      .expect(400);
    await auth(http().post(`${path(versionId)}/accept`))
      .send({ pendingMediaId: '00000000-0000-4000-8000-000000000000', imageMediaId: 'y' })
      .expect(400);
    await auth(http().get(`/admin/versions/not-a-uuid/world/oblomov/image`)).expect(400);
  });

  it('the stage registry has no world_image; world_image tasks still have a handler', () => {
    expect(app.get(LlmStageRegistry).get('world_image')).toBeUndefined();
    expect(app.get(LlmTaskHandlerRegistry).kinds()).toContain('world_image');
  });

  it('left-over world_image tasks (pending, running with an expired lease) fail without the model; the operation is closed, the stale reserve released', async () => {
    const bookId = await book();
    const versionId = await version(bookId, Language.en);
    const past = new Date(Date.now() - 24 * 3600 * 1000);
    const op = await db.llmOperation.create({
      data: { kind: 'draft', bookVersionId: versionId, limitUsd: 1, status: 'active' },
    });
    await imageRow(bookId, {});
    await db.bookWorldImage.update({
      where: { bookId_key: { bookId, key: 'oblomov' } },
      data: { operationId: op.id },
    });
    const pendingTask = await db.llmTask.create({
      data: {
        kind: 'world_image',
        operationId: op.id,
        bookVersionId: versionId,
        status: 'pending',
        runAfter: past,
        payload: { key: 'oblomov' },
        pairKey: `world_image:${op.id}`,
      },
    });
    // Второй операции - шаг, оборванный выкатом посреди вызова: задача `running` с истёкшей арендой
    // и незакрытый резерв её вызова.
    const op2 = await db.llmOperation.create({
      data: {
        kind: 'draft',
        bookVersionId: versionId,
        limitUsd: 1,
        reservedUsd: '0.25',
        status: 'active',
      },
    });
    const runningTask = await db.llmTask.create({
      data: {
        kind: 'world_image',
        operationId: op2.id,
        bookVersionId: versionId,
        status: 'running',
        attempt: 1,
        ownerToken: randomUUID(),
        leaseUntil: past,
        runAfter: past,
        payload: { key: 'oblomov' },
        pairKey: `world_image:${op2.id}`,
      },
    });
    const call = await db.llmCall.create({
      data: {
        operationId: op2.id,
        stage: 'world_image',
        requestedModel: 'bytedance-seed/seedream-4.5',
        attempt: 1,
        reservedUsd: '0.25',
        startedAt: past,
        taskId: runningTask.id,
      },
    });
    await db.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { reservedUsd: '0.25' } });

    for (let i = 0; i < 5; i++) await worker.runOnce();

    for (const [task, operation] of [
      [pendingTask.id, op.id],
      [runningTask.id, op2.id],
    ]) {
      expect(await db.llmTask.findUniqueOrThrow({ where: { id: task } })).toMatchObject({
        status: 'failed',
        lastError: 'WORLD_IMAGE_GENERATION_REMOVED',
        ownerToken: null,
      });
      expect((await db.llmOperation.findUniqueOrThrow({ where: { id: operation } })).status).toBe(
        'failed',
      );
    }
    // Ни вызова модели, ни внешнего запроса.
    expect(await db.llmCall.count({ where: { operationId: { in: [op.id, op2.id] } } })).toBe(1);
    expect(externalCalls()).toHaveLength(0);

    // Резерв оборванного вызова снимает чистка исполнителя - тем же путём, что у любого отказа.
    await worker.housekeeping();
    expect(
      (await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).reserveReleasedAt,
    ).not.toBeNull();
    expect(
      (await db.llmOperation.findUniqueOrThrow({ where: { id: op2.id } })).reservedUsd.toFixed(2),
    ).toBe('0.00');
    expect(
      (await db.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } })).reservedUsd.toFixed(
        2,
      ),
    ).toBe('0.00');

    // Вид задачи с обработчиком: в счёт «без обработчика» он не попадает - счёт до и после новой
    // задачи `world_image` один и тот же (чужие задачи базы не трогаем).
    const unknownKinds = () =>
      app.get(LlmTaskService).countUnknownKinds(app.get(LlmTaskHandlerRegistry).kinds());
    const before = await unknownKinds();
    await db.llmTask.create({
      data: { kind: 'world_image', operationId: op.id, status: 'pending', runAfter: past },
    });
    expect(await unknownKinds()).toBe(before);
  });
});
