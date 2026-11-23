/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- тело ответа supertest типизировано как any */
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { WorldMentionsSchedulerService } from '../src/modules/book-world/world-mentions-scheduler.service';
import { httpServerOf } from './http-server';
import { createBookFixture } from './helpers/book-fixture';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F08-11a: иллюстрация героя (`books-app-docs/features/F08-book-wiki/batches.md` F08-11 «Посадка»;
 * решения арбитра `F08 | F08-11` Р1-Р5): непринятая картинка не отдаётся публично; ответ модели
 * не картинкой - отказ с причиной; 403 всем, кроме admin.
 */
describe('World image e2e (F08-11a)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const prompts: Array<Record<string, unknown>> = [];
  let image: () => { b64_json: string } = () => ({ b64_json: png(1536, 1536) });

  /** Заголовок PNG с `IHDR`: проверке картинки (`sniffImage`) больше не нужно. */
  function png(width: number, height: number): string {
    const b = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b.toString('base64');
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);
  const path = (versionId: string, key = 'oblomov') =>
    `/admin/versions/${versionId}/world/${key}/image`;
  const publicEntity = (versionId: string, key = 'oblomov') =>
    http().get(`/versions/${versionId}/world/${key}`).expect(200);

  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      await worker.runOnce();
      const left = await prisma.llmTask.count({
        where: { status: { in: ['pending', 'running'] }, operation: { status: 'active' } },
      });
      if (left === 0) return;
    }
    throw new Error('drain did not finish');
  };

  const resetBudget = () =>
    prisma.llmBudget.upsert({
      where: { id: LLM_BUDGET_ID },
      create: { id: LLM_BUDGET_ID, ceilingUsd: 100, defaultRunLimitUsd: 10 },
      update: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0, defaultRunLimitUsd: 10 },
    });

  /** Опубликованная версия книги и герой на сайте (`isListed` - как его ставит запись мира). */
  const version = async (
    bookId: string,
    language: Language,
    hero: { role?: string; appearance?: string | null; key?: string } = {},
  ) => {
    const v = await prisma.bookVersion.create({
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
    await prisma.bookWorldEntity.create({
      data: {
        bookVersionId: v.id,
        key: hero.key ?? 'oblomov',
        type: 'character',
        name: 'Ilya Oblomov',
        role: hero.role ?? 'main',
        blocks:
          hero.appearance === null
            ? {}
            : {
                appearance:
                  hero.appearance ?? 'A plump man of about thirty-two in a dressing gown.',
              },
        hasCore: true,
        isListed: true,
        readAt: new Date(),
      },
    });
    await prisma.bookAnalysis.create({
      data: {
        bookVersionId: v.id,
        facts: { settingPlace: 'St Petersburg', settingTime: '1840s' },
      },
    });
    return v.id;
  };

  const book = async () =>
    (
      await createBookFixture(
        prisma,
        `world-image-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
      )
    ).id;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
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
    prompts.length = 0;
    image = () => ({ b64_json: png(1536, 1536) });
    await resetBudget();
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
      if (urlOf(url).endsWith('/models')) return Promise.resolve(json({ data: [] }));
      if (urlOf(url).endsWith('/images')) {
        const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
        prompts.push(body);
        return Promise.resolve(json({ model: body.model, data: [image()], usage: { cost: 0.04 } }));
      }
      return Promise.reject(new Error(`unexpected fetch ${urlOf(url)}`));
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    process.env.OPENROUTER_API_KEY = '';
    await prisma.llmTask.updateMany({
      where: { status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('access: every route is admin only; no token - 401', async () => {
    const versionId = await version(await book(), Language.en);
    for (const [method, url] of [
      ['get', path(versionId)],
      ['post', path(versionId)],
      ['post', `${path(versionId)}/accept`],
    ] as Array<['get' | 'post', string]>) {
      await http()[method](url).expect(401);
      await auth(http()[method](url), 'cm').expect(403);
      await auth(http()[method](url), 'user').expect(403);
    }
    expect(prompts).toHaveLength(0);
  });

  it('refusals: a minor character, a character without appearance, an unknown key', async () => {
    const bookId = await book();
    const minor = await version(bookId, Language.en, { role: 'minor' });
    const noAppearance = await version(bookId, Language.ru, { appearance: null });
    expect((await auth(http().post(path(minor))).expect(409)).body.code).toBe(
      'WORLD_IMAGE_NOT_ALLOWED',
    );
    expect((await auth(http().post(path(noAppearance))).expect(409)).body.code).toBe(
      'WORLD_IMAGE_NO_APPEARANCE',
    );
    await auth(http().post(path(minor, 'nobody'))).expect(404);
    expect((await auth(http().get(path(minor))).expect(200)).body).toMatchObject({
      allowed: false,
      accepted: null,
      pending: null,
      generation: null,
    });
    expect(prompts).toHaveLength(0);
  });

  it('generated image waits for Accept: not public until accepted, then on every language of the book; regenerate keeps the accepted one', async () => {
    const bookId = await book();
    const en = await version(bookId, Language.en);
    const ru = await version(bookId, Language.ru);

    const started = await auth(http().post(path(en))).expect(202);
    expect(started.body.generation).toMatchObject({ status: 'active', failedReason: null });
    expect((await auth(http().post(path(en))).expect(409)).body.code).toBe(
      'WORLD_IMAGE_IN_PROGRESS',
    );
    await drain();

    // Промпт - по внешности и фактам анализа, без имени героя и названия книги (`product.md` §8).
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      provider: { data_collection: 'deny' },
      aspect_ratio: '1:1',
    });
    expect(String(prompts[0].prompt)).toContain('dressing gown');
    expect(String(prompts[0].prompt)).toContain('St Petersburg');
    expect(String(prompts[0].prompt)).not.toMatch(/Oblomov|Goncharov/);

    const waiting = (await auth(http().get(path(en))).expect(200)).body;
    expect(waiting.generation).toMatchObject({ status: 'done', spentUsd: '0.04000000' });
    expect(waiting.accepted).toBeNull();
    expect(waiting.pending).toMatchObject({ width: 1536, height: 1536 });
    expect(waiting.pending.url).toMatch(/illustrations\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\.png$/);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: waiting.pending.mediaId },
    });
    expect(asset.contentType).toBe('image/png');

    // Непринятая: ни читателю, ни редактору на странице сущности.
    expect((await publicEntity(en)).body.image).toBeNull();
    const editorView = await auth(http().get(`/versions/${en}/world/oblomov`)).expect(200);
    expect(editorView.body.image).toBeNull();

    // Accept чужой картинки - 409; своей - картинка на сайте у обоих языков книги.
    expect(
      (
        await auth(http().post(`${path(en)}/accept`))
          .send({ pendingMediaId: '00000000-0000-4000-8000-000000000000' })
          .expect(409)
      ).body.code,
    ).toBe('WORLD_IMAGE_CHANGED');
    await auth(http().post(`${path(en)}/accept`))
      .send({ pendingMediaId: waiting.pending.mediaId })
      .expect(200);
    const accepted = { url: waiting.pending.url, width: 1536, height: 1536 };
    expect((await publicEntity(en)).body.image).toEqual(accepted);
    expect((await publicEntity(ru)).body.image).toEqual(accepted);

    // Перегенерация пишет только в ожидающую: на сайте прежняя до нового Accept.
    await auth(http().post(path(ru))).expect(202);
    await drain();
    const again = (await auth(http().get(path(ru))).expect(200)).body;
    expect(again.accepted).toMatchObject(accepted);
    expect(again.pending.mediaId).not.toBe(waiting.pending.mediaId);
    expect((await publicEntity(en)).body.image).toEqual(accepted);

    // Принимать нечего - 409.
    await auth(http().post(`${path(ru)}/accept`))
      .send({ pendingMediaId: again.pending.mediaId })
      .expect(200);
    expect(
      (
        await auth(http().post(`${path(ru)}/accept`))
          .send({ pendingMediaId: again.pending.mediaId })
          .expect(409)
      ).body.code,
    ).toBe('WORLD_IMAGE_NONE');
  });

  it('a Generate that waited for the row lock sees the generation committed meanwhile: 409, no second operation (L-019)', async () => {
    const versionId = await version(await book(), Language.en);
    await auth(http().post(path(versionId))).expect(202);
    await drain();
    const row = await prisma.bookWorldImage.findFirstOrThrow({
      where: { key: 'oblomov', book: { versions: { some: { id: versionId } } } },
    });
    const opsBefore = await prisma.llmOperation.count({ where: { bookVersionId: versionId } });

    // Детерминированное пересечение: «первая генерация» держит замок строки, вторая «Generate»
    // встаёт на него в ожидание, первая заводит активную операцию и коммитит - только после этого
    // вторая получает замок. Без барьера два запроса могли бы просто не пересечься.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "BookWorldImage" WHERE "id" = ${row.id} FOR UPDATE`;
        await released;
        const op = await tx.llmOperation.create({
          data: { kind: 'draft', bookVersionId: versionId, limitUsd: 1, status: 'active' },
          select: { id: true },
        });
        await tx.bookWorldImage.update({ where: { id: row.id }, data: { operationId: op.id } });
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
    const second = auth(http().post(path(versionId))).then((r) => r);
    for (let i = 0; i < 200; i++) {
      const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (Number(waiting[0].n) > 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    release();
    await holder;
    const answer = await second;

    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe('WORLD_IMAGE_IN_PROGRESS');
    // Ровно одна новая операция - та, что держала замок; вторая «Generate» свою не завела.
    expect(await prisma.llmOperation.count({ where: { bookVersionId: versionId } })).toBe(
      opsBefore + 1,
    );
    await prisma.llmOperation.updateMany({
      where: { bookVersionId: versionId, status: 'active' },
      data: { status: 'cancelled' },
    });
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

  it('a failed regeneration keeps the accepted image; a demoted character shows none, accept refuses (Q1)', async () => {
    const versionId = await version(await book(), Language.en);
    await auth(http().post(path(versionId))).expect(202);
    await drain();
    const first = (await auth(http().get(path(versionId))).expect(200)).body;
    await auth(http().post(`${path(versionId)}/accept`))
      .send({ pendingMediaId: first.pending.mediaId })
      .expect(200);
    const accepted = { url: first.pending.url, width: 1536, height: 1536 };

    // Отказ модели поверх принятой: принятая на сайте как была, ожидающей нет.
    image = () => ({ b64_json: png(1024, 1024) });
    await auth(http().post(path(versionId))).expect(202);
    await drain();
    const failed = (await auth(http().get(path(versionId))).expect(200)).body;
    expect(failed).toMatchObject({ accepted, pending: null });
    expect(failed.generation).toMatchObject({ status: 'failed' });
    const page = (await publicEntity(versionId)).body as Record<string, unknown>;
    expect(page.image).toEqual(accepted);
    // Наружу - только принятая картинка: ни ячеек, ни операции.
    expect(Object.keys(page).sort()).toEqual(
      ['alternates', 'chapterNumbers', 'entity', 'image', 'language'].sort(),
    );

    // Героя понизили: картинки на странице нет, «Accept» - 409; строка не тронута.
    image = () => ({ b64_json: png(1536, 1536) });
    await auth(http().post(path(versionId))).expect(202);
    await drain();
    const pending = (await auth(http().get(path(versionId))).expect(200)).body.pending;
    await prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key: 'oblomov' } },
      data: { role: 'secondary' },
    });
    expect((await publicEntity(versionId)).body.image).toEqual(accepted);
    await prisma.bookWorldEntity.update({
      where: { bookVersionId_key: { bookVersionId: versionId, key: 'oblomov' } },
      data: { role: 'minor', isListed: true },
    });
    expect((await publicEntity(versionId)).body.image).toBeNull();
    expect(
      (
        await auth(http().post(`${path(versionId)}/accept`))
          .send({ pendingMediaId: pending.mediaId })
          .expect(409)
      ).body.code,
    ).toBe('WORLD_IMAGE_NOT_ALLOWED');
  });

  it.each([
    [
      'an SVG',
      () => ({
        b64_json: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      }),
      'WORLD_IMAGE_NOT_IMAGE',
    ],
    ['a 1024 px image', () => ({ b64_json: png(1024, 1024) }), 'WORLD_IMAGE_TOO_SMALL'],
    ['no image at all', () => ({ b64_json: '' }), 'WORLD_IMAGE_NOT_IMAGE'],
  ])(
    'the model answers %s: the generation fails with its reason, nothing is stored',
    async (_, answer, reason) => {
      image = answer;
      const versionId = await version(await book(), Language.en);
      const assetsBefore = await prisma.mediaAsset.count();
      await auth(http().post(path(versionId))).expect(202);
      await drain();
      const state = (await auth(http().get(path(versionId))).expect(200)).body;
      expect(state.generation).toMatchObject({ status: 'failed', failedReason: reason });
      expect(state.pending).toBeNull();
      expect(await prisma.mediaAsset.count()).toBe(assetsBefore);
      expect((await publicEntity(versionId)).body.image).toBeNull();
    },
  );
});
