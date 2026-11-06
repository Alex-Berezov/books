import { randomUUID } from 'crypto';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { ContentDraftService } from '../src/modules/translation/content-draft/content-draft.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * Снятые заготовки из досье: пошаговые Summary `F05-10` (сняты в `F06-3`, решения арбитра
 * `F06 | F06-3`, А1, А2) и Analysis «Draft from dossier» `F05-11` (снята в `F07-3a`, решение
 * арбитра `F07 | F07-3`). Маршрутов `drafts/:kind` и `content-drafts/:id/discard` нет - 404,
 * строки не создаются; строящиеся строки снятых видов отбрасывает дренаж при старте, а задачу,
 * взятую исполнителем до него, - обработчик. Ходы `summary_write` и `analysis_write` живут
 * в своих спеках; здесь - только то, что их строки дренаж не трогает. Модель не зовётся ни разу:
 * внешний `fetch` подменён и считает вызовы.
 */
describe('Retired drafts from the dossier (e2e)', () => {
  const RETIRED_KINDS = ['summary_sections', 'summary_full', 'summary_brief', 'analysis'] as const;

  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();
  const slugs: string[] = [];
  const calls: string[] = [];

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);

  const THREE_CHAPTERS = [1, 2, 3].map((n) => ({
    number: n,
    title: `C${n}`,
    content: `<p>Anna in chapter ${n}.</p>`,
  }));

  /** Книга с версиями: язык → «язык оригинала» и главы. */
  const book = async (
    versions: Array<{
      language: Language;
      originalLanguage: string | null;
      chapters?: Array<{ number: number; title: string; content: string }>;
    }>,
  ) => {
    const slug = `f0510-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book: created } = await createBookWithRights(prisma, slug);
    const ids: Partial<Record<Language, string>> = {};
    for (const v of versions) {
      const row = await prisma.bookVersion.create({
        data: {
          bookId: created.id,
          language: v.language,
          title: `Book ${v.language}`,
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'draft',
          originalLanguage: v.originalLanguage,
          chapters: { create: v.chapters ?? [] },
        },
      });
      ids[v.language] = row.id;
    }
    return { bookId: created.id, ids };
  };

  const sourceBook = async () =>
    (await book([{ language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS }])).ids
      .en as string;

  /** Проходы исполнителя до конца: ждущая заготовка (`wait`) перепроверяется сразу. */
  const drain = async () => {
    for (let i = 0; i < 80; i++) {
      await prisma.llmTask.updateMany({
        where: { status: 'pending', runAfter: { gt: new Date() } },
        data: { runAfter: new Date(Date.now() - 1000) },
      });
      await worker.runOnce();
      const left = await prisma.llmTask.count({
        where: { status: { in: ['pending', 'running'] }, operation: { status: 'active' } },
      });
      if (left === 0) return;
    }
    throw new Error('drain did not finish');
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    worker = app.get(LlmWorkerService);
    const adminEmail = `f0510-admin-${stamp}@test.com`;
    const cmEmail = `f0510-cm-${stamp}@test.com`;
    const userEmail = `f0510-user-${stamp}@test.com`;
    for (const email of [adminEmail, cmEmail, userEmail]) {
      await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
    }
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    for (const [who, email] of [
      ['admin', adminEmail],
      ['cm', cmEmail],
      ['user', userEmail],
    ] as const) {
      const res = await http()
        .post('/auth/login')
        .send({ email, password: 'password123' })
        .expect(200);
      tokens[who] = (res.body as { accessToken: string }).accessToken;
    }
  });

  beforeEach(() => {
    calls.length = 0;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      calls.push('fetch');
      return Promise.reject(new Error('the model must not be called'));
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await prisma.llmTask.updateMany({
      where: { status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled' },
    });
  });

  afterAll(async () => {
    for (const slug of slugs) await cleanupBookWithRights(prisma, slug);
    await app.close();
  });

  /** Строящаяся строка вида с операцией `draft` и `pending`-задачей `content_draft`, как от старта. */
  const buildingRow = async (
    versionId: string,
    kind: (typeof RETIRED_KINDS)[number] | 'summary_write' | 'analysis_write',
    opStatus: 'active' | 'paused',
  ) => {
    const op = await prisma.llmOperation.create({
      data: {
        kind: 'draft',
        bookVersionId: versionId,
        limitUsd: new Prisma.Decimal(1),
        status: opStatus,
        pauseReason: opStatus === 'paused' ? 'CEILING_REACHED' : null,
      },
    });
    const row = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind,
        status: 'building',
        language: 'en',
        operationId: op.id,
      },
    });
    const task = await prisma.llmTask.create({
      data: {
        kind: 'content_draft',
        operationId: op.id,
        bookVersionId: versionId,
        language: 'en',
        payload: { draftId: row.id },
        pairKey: `${op.id}:${row.id}`,
      },
    });
    return { rowId: row.id, opId: op.id, taskId: task.id };
  };
  const stateOf = async (ids: { rowId: string; opId: string; taskId: string }) => ({
    row: (await prisma.contentDraft.findUniqueOrThrow({ where: { id: ids.rowId } })).status,
    op: (await prisma.llmOperation.findUniqueOrThrow({ where: { id: ids.opId } })).status,
    task: (await prisma.llmTask.findUniqueOrThrow({ where: { id: ids.taskId } })).status,
  });

  it('the draft routes are gone for every kind (F07-3a): estimate, state, start and discard by id - 404 for admin, no row, no operation', async () => {
    const versionId = await sourceBook();
    const op = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: new Prisma.Decimal(1), status: 'done' },
    });
    const ready = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind: 'analysis',
        status: 'ready',
        language: 'en',
        operationId: op.id,
        data: { analysis: { language: 'en' } },
      },
    });
    const opsBefore = await prisma.llmOperation.count();
    for (const kind of [...RETIRED_KINDS, 'symbols']) {
      for (const [method, path] of [
        ['get', `/admin/versions/${versionId}/drafts/${kind}/estimate`],
        ['get', `/admin/versions/${versionId}/drafts/${kind}`],
        ['post', `/admin/versions/${versionId}/drafts/${kind}`],
      ] as Array<['get' | 'post', string]>) {
        const res = await auth(http()[method](path)).send({}).expect(404);
        // «Нет маршрута», а не отказ сервиса по виду или версии.
        expect((res.body as { message: string }).message).toMatch(/^Cannot (GET|POST) /);
      }
    }
    const discard = await auth(http().post(`/admin/content-drafts/${ready.id}/discard`)).expect(
      404,
    );
    expect((discard.body as { message: string }).message).toMatch(/^Cannot POST /);
    // Готовая строка снятого вида не тронута, новых строк и операций нет.
    expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: ready.id } })).toMatchObject({
      status: 'ready',
      data: { analysis: { language: 'en' } },
    });
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(1);
    expect(await prisma.llmOperation.count()).toBe(opsBefore);
    expect(calls).toHaveLength(0);
  });

  it('a row of a retired kind is not a run (F07-1b, В6): the shared run routes answer 404, the row untouched', async () => {
    const versionId = await sourceBook();
    for (const kind of RETIRED_KINDS) {
      const op = await prisma.llmOperation.create({
        data: { kind: 'draft', limitUsd: new Prisma.Decimal(1), status: 'done' },
      });
      const row = await prisma.contentDraft.create({
        data: {
          bookVersionId: versionId,
          kind,
          status: 'ready',
          language: 'en',
          operationId: op.id,
        },
      });
      for (const path of ['accept-all', 'discard-run', 'items/0/accept']) {
        await auth(http().post(`/admin/content-drafts/${row.id}/${path}`))
          .send({})
          .expect(404);
      }
      expect((await prisma.contentDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        'ready',
      );
    }
  });

  it('drain at start (F06-3, А1; F07-3a): building rows of every retired kind - discarded, their active and paused operations and pending tasks cancelled; runs untouched; a repeat changes nothing', async () => {
    const versionId = await sourceBook();
    const sections = await buildingRow(versionId, 'summary_sections', 'active');
    const full = await buildingRow(versionId, 'summary_full', 'paused');
    const analysis = await buildingRow(versionId, 'analysis', 'active');
    const summaryRun = await buildingRow(versionId, 'summary_write', 'active');
    const analysisRun = await buildingRow(versionId, 'analysis_write', 'active');
    const pausedAnalysis = await buildingRow(await sourceBook(), 'analysis', 'paused');
    const drafts = app.get(ContentDraftService);

    expect(await drafts.drainRetiredDrafts()).toBe(4);
    for (const retired of [sections, full, analysis, pausedAnalysis]) {
      expect(await stateOf(retired)).toEqual({
        row: 'discarded',
        op: 'cancelled',
        task: 'cancelled',
      });
    }
    for (const run of [summaryRun, analysisRun]) {
      expect(await stateOf(run)).toEqual({ row: 'building', op: 'active', task: 'pending' });
    }

    // Повтор: строк снятых видов в `building` нет - ничего не меняется.
    const snapshot = await prisma.contentDraft.findMany({
      where: { bookVersionId: versionId },
      include: { operation: { include: { tasks: true } } },
      orderBy: { createdAt: 'asc' },
    });
    expect(await drafts.drainRetiredDrafts()).toBe(0);
    expect(
      await prisma.contentDraft.findMany({
        where: { bookVersionId: versionId },
        include: { operation: { include: { tasks: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ).toEqual(snapshot);
    expect(calls).toHaveLength(0);

    // Строящиеся ходы без настоящего старта не остаются висеть на следующие наборы.
    for (const run of [summaryRun, analysisRun]) {
      await auth(http().post(`/admin/content-drafts/${run.rowId}/discard-run`)).expect(200);
    }
  });

  it.each(['summary_brief', 'analysis'] as const)(
    'a task of a building %s row taken by the worker (А1): the row discarded, its operation cancelled, the model not called, the row not failed',
    async (kind) => {
      const versionId = await sourceBook();
      const retired = await buildingRow(versionId, kind, 'active');
      await drain();
      expect(calls).toHaveLength(0);
      // Задачу взял обработчик (шаг завершён `done`), а не отменил дренаж.
      expect(await stateOf(retired)).toEqual({ row: 'discarded', op: 'cancelled', task: 'done' });
      const row = await prisma.contentDraft.findUniqueOrThrow({ where: { id: retired.rowId } });
      expect(row.failedReason).toBeNull();
    },
  );

  it('the run routes stay admin only; no token - 401; an unknown version - 404', async () => {
    const versionId = await sourceBook();
    for (const who of ['cm', 'user'] as const) {
      await auth(http().get(`/admin/versions/${versionId}/drafts/analysis_write`), who).expect(403);
    }
    await http().get(`/admin/versions/${versionId}/drafts/analysis_write`).expect(401);
    await auth(http().get(`/admin/versions/${randomUUID()}/drafts/analysis_write/estimate`)).expect(
      404,
    );
  });
});
