/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { ContentDraftService } from '../src/modules/translation/content-draft/content-draft.service';
import {
  ContextEstimate,
  DossierDemandService,
} from '../src/modules/translation/dossier/dossier-demand.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-11: заготовка Analysis из досье. Пошаговые заготовки Summary `F05-10` сняты в `F06-3`
 * (решения арбитра `F06 | F06-3`, А1, А2): их ручки - 400, строки - 404, строящиеся отбрасывает
 * дренаж. Построение идёт настоящим исполнителем на базе: его
 * таймер в e2e не заведён (ключа на старте нет, Р25), проходы зовутся руками. Внешний `fetch`
 * подменён всегда: ответ модели выбирается по имени схемы ответа.
 */
describe('Summary drafts from the dossier (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const MODELS = {
    data: [
      {
        id: MODEL,
        name: MODEL,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['structured_outputs'],
      },
    ],
  };

  const PART = {
    summary: 'Something happens.',
    characters: [
      {
        name: 'Anna',
        variants: [],
        gender: 'female',
        whoIs: 'heroine',
        address: [],
        relations: [],
      },
    ],
    entities: [],
    events: [{ event: 'Anna arrives', orderNote: '' }],
    voice: { notes: 'calm', devices: [] },
    motifs: [],
  };
  /** План разделов досье: часть формы ответа досье, заготовка Analysis его не читает. */
  const PLAN = [
    { number: 1, title: 'Chapter 1. One', chapters: [1], why: 'opening' },
    { number: 2, title: 'Chapters 2-3', chapters: [2, 3], why: 'ending' },
  ];
  const DOSSIER = {
    characters: [
      {
        key: 'anna',
        name: 'Anna',
        variants: [],
        gender: 'female',
        whoIs: 'heroine',
        address: [],
        relations: [],
        firstChapter: 1,
        fate: 'leaves',
        role: 'main',
      },
    ],
    entities: [],
    narration: { person: 'third', form: 'prose', notes: '' },
    setting: { place: 'Town', time: '1900s' },
    structure: { parts: [], notes: '' },
    chronology: [],
    chapters: [1, 2, 3].map((n) => ({ number: n, title: `C${n}`, summary: 'S.' })),
    summaryPlan: PLAN,
    voice: { pace: 'slow', sentenceLength: 'long', lexicon: 'plain', irony: 'none', devices: [] },
    motifs: [],
  };
  const GLOSSARY = {
    entries: [
      {
        key: 'anna',
        source: 'Anna',
        target: 'Annette',
        kind: 'character',
        keepOriginal: false,
        note: '',
      },
    ],
    address: [],
    phrases: [],
  };
  /** Ответ анализа по умолчанию: одна цитата, которая есть в главе 3. */
  const ANALYSIS = {
    facts: { settingPlace: '', settingTime: '', narrator: '', structure: '' },
    characters: [],
    keyQuotes: [{ text: 'Anna in chapter 3.', chapter: 3, speakerKey: '' }],
    style: [],
  };
  /** Снятые в `F06-3` виды заготовок Summary (А1, А2). */
  const RETIRED_KINDS = ['summary_sections', 'summary_full', 'summary_brief'] as const;

  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();
  const slugs: string[] = [];

  interface ChatBody {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { json_schema?: { name?: string } };
  }
  /** Ответ модели по имени схемы; может быть промисом - `fetch` его дождётся. */
  let answer: (name: string, body: ChatBody) => unknown;
  const calls: Array<{ name: string; body: ChatBody }> = [];
  const callsOf = (name: string) => calls.filter((c) => c.name === name);

  const defaultAnswer = (name: string): unknown =>
    ({
      dossier_part: PART,
      dossier: DOSSIER,
      glossary: GLOSSARY,
      analysis_draft: ANALYSIS,
    })[name];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

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

  const start = (versionId: string, kind: string, body: object = {}) =>
    auth(http().post(`/admin/versions/${versionId}/drafts/${kind}`)).send(body);
  /** Тело заготовки из ответа: поля, которые проверяют посадки. */
  interface DraftBody {
    id: string;
    status: string;
    waitingFor: string | null;
    operation: { status: string; pauseReason: string | null };
  }
  const latest = async (versionId: string, kind: string): Promise<DraftBody | null> =>
    (
      (await auth(http().get(`/admin/versions/${versionId}/drafts/${kind}`)).expect(200)).body as {
        draft: DraftBody | null;
      }
    ).draft;
  /** Заготовка, которая обязана быть. */
  const draftOf = async (versionId: string, kind: string): Promise<DraftBody> => {
    const draft = await latest(versionId, kind);
    if (!draft) throw new Error(`no ${kind} draft of ${versionId}`);
    return draft;
  };

  /** Готовое досье исходника нужного отпечатка - через кнопку и исполнителя, как в админке. */
  const buildDossier = async (versionId: string) => {
    await auth(http().post(`/admin/versions/${versionId}/dossier`))
      .send({})
      .expect(202);
    await drain();
    return prisma.bookDossier.findFirstOrThrow({
      where: { sourceVersionId: versionId, status: 'ready' },
      orderBy: { generation: 'desc' },
    });
  };

  const resetBudget = () =>
    prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0, defaultRunLimitUsd: 10 },
    });

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
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    answer = (name) => defaultAnswer(name);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (urlOf(url).endsWith('/models')) return json(MODELS);
      if (urlOf(url).endsWith('/chat/completions')) {
        const body = JSON.parse((init as RequestInit).body as string) as ChatBody;
        const name = llmCallName(body);
        calls.push({ name, body });
        return json({
          model: body.model,
          provider: 'E2EProvider',
          choices: [{ message: { content: JSON.stringify(await answer(name, body)) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
        });
      }
      throw new Error(`unexpected fetch ${urlOf(url)}`);
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
    process.env.OPENROUTER_API_KEY = '';
    await prisma.llmTask.updateMany({
      where: { status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled' },
    });
    await resetBudget();
  });

  afterAll(async () => {
    for (const slug of slugs) await cleanupBookWithRights(prisma, slug);
    await app.close();
  });

  it('access: admin only; an unknown kind - 400', async () => {
    const versionId = await sourceBook();
    for (const [method, path] of [
      ['get', `/admin/versions/${versionId}/drafts/analysis/estimate`],
      ['get', `/admin/versions/${versionId}/drafts/analysis`],
      ['post', `/admin/versions/${versionId}/drafts/analysis`],
      ['post', `/admin/content-drafts/${versionId}/discard`],
    ] as Array<['get' | 'post', string]>) {
      await auth(http()[method](path), 'cm').expect(403);
      await auth(http()[method](path), 'user').expect(403);
    }
    await auth(http().get(`/admin/versions/${versionId}/drafts/symbols`)).expect(400);
    expect(await latest(versionId, 'analysis')).toBeNull();
  });

  it('retired Summary kinds (F06-3, А2): estimate, state and start of summary_sections, summary_full and summary_brief - 400, no draft row and no operation', async () => {
    const versionId = await sourceBook();
    const opsBefore = await prisma.llmOperation.count();
    for (const kind of RETIRED_KINDS) {
      for (const [method, path] of [
        ['get', `/admin/versions/${versionId}/drafts/${kind}/estimate`],
        ['get', `/admin/versions/${versionId}/drafts/${kind}`],
        ['post', `/admin/versions/${versionId}/drafts/${kind}`],
      ] as Array<['get' | 'post', string]>) {
        await auth(http()[method](path)).send({}).expect(400);
      }
    }
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(await prisma.llmOperation.count()).toBe(opsBefore);
    expect(calls).toHaveLength(0);
  });

  it('a row of a retired Summary kind (F06-3, А2): discard by id - 404, the added mark route is gone - 404; the row untouched', async () => {
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
          data: { text: '<p>Old.</p>' },
        },
      });
      await auth(http().post(`/admin/content-drafts/${row.id}/discard`)).expect(404);
      expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        status: 'ready',
        data: { text: '<p>Old.</p>' },
      });
    }
    expect(await latest(versionId, 'analysis')).toBeNull();
    // Снятая ручка отметки - на строке analysis: прежний маршрут ответил бы 409 DRAFT_NOT_READY,
    // отказ по виду - 404 `Content draft not found`; «нет маршрута» - 404 `Cannot POST`.
    const op = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: new Prisma.Decimal(1), status: 'done' },
    });
    const analysis = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind: 'analysis',
        status: 'ready',
        language: 'en',
        operationId: op.id,
      },
    });
    const added = await auth(
      http().post(`/admin/content-drafts/${analysis.id}/sections/1/added`),
    ).expect(404);
    expect((added.body as { message: string }).message).toMatch(/^Cannot POST /);
  });

  // Строка хода пересказа `F06` - не заготовка (решение арбитра `F06 | F06-1`, В2), но ручки
  // `drafts/summary_write` с `F06-2` - её (`F06 | F06-2`, Р6), отбрасывает её `discard-run` (Р9);
  // `discard` и ответ заготовки строку хода по-прежнему не видят.
  it('a summary_write row of F06 is a summary run, not a draft: its routes answer the run, discard-run discards it; discard by id is 404, drafts do not see it', async () => {
    const versionId = await sourceBook();
    const op = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: new Prisma.Decimal(1), status: 'done' },
    });
    const row = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind: 'summary_write',
        status: 'ready',
        language: 'en',
        operationId: op.id,
      },
    });
    const state = await auth(
      http().get(`/admin/versions/${versionId}/drafts/summary_write`),
    ).expect(200);
    expect(state.body.draft).toMatchObject({ id: row.id, status: 'ready', items: [] });
    // Оценка и старт - ручки хода, а не 400 вида: в каталоге этой спеки у моделей этапов хода нет
    // цены - отказ оценки хода; сам ход - `summary-write.e2e-spec.ts`.
    const estimate = await auth(
      http().get(`/admin/versions/${versionId}/drafts/summary_write/estimate`),
    ).expect(409);
    expect(estimate.body.code).toBe('LLM_NO_PRICE');
    expect((await start(versionId, 'summary_write').expect(409)).body.code).toBe('LLM_NO_PRICE');
    expect(await latest(versionId, 'analysis')).toBeNull();
    // `discard` заготовок строку хода не видит (В2); ход отбрасывает `discard-run` (Р9).
    await auth(http().post(`/admin/content-drafts/${row.id}/discard`)).expect(404);
    expect((await prisma.contentDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'ready',
    );
    const discarded = await auth(http().post(`/admin/content-drafts/${row.id}/discard-run`)).expect(
      200,
    );
    expect(discarded.body).toMatchObject({ id: row.id, status: 'discarded', items: [] });
    const after = await prisma.contentDraft.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('discarded');
    // Операция кончилась до отмены - её статус не трогается.
    const opAfter = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe('done');
  });

  it('analysis on the source: built over the saved analysis, made-up quotes thrown away with a mark, the draft passes the import save, the saved analysis untouched (F05-11)', async () => {
    const versionId = await sourceBook();
    await auth(http().put(`/versions/${versionId}/analysis`))
      .send({
        language: 'en',
        facts: { settingPlace: 'Saved town' },
        characters: [{ key: 'anna', name: 'Anna', role: 'main', description: 'Saved words' }],
        keyQuotes: [{ text: 'Saved quote', interpretation: 'Saved meaning' }],
      })
      .expect(200);
    const before = await prisma.bookAnalysis.findUniqueOrThrow({
      where: { bookVersionId: versionId },
    });
    const motifDossier = {
      ...DOSSIER,
      motifs: [{ image: 'the door', chapters: [2] }],
    };
    answer = (name) =>
      name === 'dossier'
        ? motifDossier
        : name === 'analysis_draft'
          ? {
              facts: { settingPlace: 'Other', settingTime: '1900s', narrator: '', structure: '' },
              characters: [
                {
                  key: 'anna',
                  name: 'Anna',
                  role: 'main',
                  arcFrom: 'alone',
                  arcTo: 'at home',
                  quote: 'Anna in chapter 1.',
                  quoteChapter: 1,
                  relations: [],
                },
              ],
              keyQuotes: [
                { text: 'Anna in chapter 2.', chapter: 2, speakerKey: '' },
                { text: 'Anna never was here.', chapter: 2, speakerKey: '' },
                { text: 'Anna in chapter 3.', chapter: 7, speakerKey: '' },
              ],
              style: [],
            }
          : defaultAnswer(name);

    const estimate = await auth(
      http().get(`/admin/versions/${versionId}/drafts/analysis/estimate`),
    ).expect(200);
    expect(estimate.body).toEqual(expect.objectContaining({ kind: 'analysis', upperBound: true }));
    // Поле оценки `sections` снято вместе с пошаговыми видами (`F06-3`).
    expect(estimate.body).not.toHaveProperty('sections');
    expect(estimate.body.dossier).toMatchObject({ refusedTooLong: false });
    await start(versionId, 'analysis').expect(202);
    await drain();

    const res = await auth(http().get(`/admin/versions/${versionId}/drafts/analysis`)).expect(200);
    const draft = (res.body as { draft: DraftBody & Record<string, unknown> }).draft;
    expect(draft.status).toBe('ready');
    expect(draft.analysis).toEqual({
      language: 'en',
      facts: { settingPlace: 'Saved town', settingTime: '1900s' },
      characters: [
        {
          key: 'anna',
          name: 'Anna',
          role: 'main',
          description: 'Saved words',
          arc: { from: 'alone', to: 'at home' },
          quote: { text: 'Anna in chapter 1.', chapter: 1 },
        },
      ],
      keyQuotes: [
        { text: 'Saved quote', interpretation: 'Saved meaning' },
        { text: 'Anna in chapter 2.', chapter: 2 },
      ],
    });
    expect(draft.droppedQuotes).toEqual([
      { path: 'keyQuotes', text: 'Anna never was here.', chapter: 2, reason: 'NOT_FOUND' },
      { path: 'keyQuotes', text: 'Anna in chapter 3.', chapter: 7, reason: 'CHAPTER_MISSING' },
    ]);
    expect(draft.motifs).toEqual([{ image: 'the door', chapters: [2] }]);
    expect(draft.dossierLanguage).toBe('en');
    expect(draft.analysisUpdatedAt).toBe(before.updatedAt.toISOString());
    // Модель получила весь текст версии и сохранённый анализ (Р8).
    const prompt = callsOf('analysis_draft')[0].body.messages[1].content;
    for (const n of [1, 2, 3]) expect(prompt).toContain(`[READER CHAPTER ${n}]`);
    expect(prompt).toContain('Saved quote');

    // Заготовка проходит сохранение анализа (проба), а сохранённое не изменилось.
    await auth(http().put(`/versions/${versionId}/analysis?dryRun=true`))
      .send(draft.analysis as object)
      .expect(200);
    const after = await prisma.bookAnalysis.findUniqueOrThrow({
      where: { bookVersionId: versionId },
    });
    expect(after).toEqual(before);
  });

  it('analysis on a manual version whose glossary is not built yet: the estimate is an upper bound with the glossary line (F05-11)', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS },
      { language: 'fr', originalLanguage: 'English', chapters: THREE_CHAPTERS },
    ]);
    await buildDossier(ids.en as string);
    const estimate = await auth(
      http().get(`/admin/versions/${ids.fr as string}/drafts/analysis/estimate`),
    ).expect(200);
    expect(estimate.body).toEqual(
      expect.objectContaining({ kind: 'analysis', dossier: null, upperBound: true }),
    );
    expect(estimate.body.glossary).not.toBeNull();
  });

  it('analysis estimate with a ready dossier is not an upper bound; a limit below the dossier built first - 400 (F05-11)', async () => {
    const built = await sourceBook();
    await buildDossier(built);
    const ready = await auth(
      http().get(`/admin/versions/${built}/drafts/analysis/estimate`),
    ).expect(200);
    expect(ready.body).toEqual(
      expect.objectContaining({
        kind: 'analysis',
        dossier: null,
        glossary: null,
        upperBound: false,
      }),
    );
    // Лимит по умолчанию закладывает повтор с замечанием (Р28): этап × (1 + 1) × 1,5.
    expect(Number(ready.body.suggestedLimitUsd)).toBeCloseTo(Number(ready.body.stageUsd) * 3, 6);

    const fresh = await sourceBook();
    const res = await start(fresh, 'analysis', { limitUsd: '0.00000001' }).expect(400);
    expect(res.body.code).toBe('DRAFT_LIMIT_TOO_LOW');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: fresh } })).toBe(0);
  });

  it('analysis on a version without chapter text: 409 SOURCE_HAS_NO_CHAPTERS before any operation (F05-11, Р26)', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS },
      {
        language: 'fr',
        originalLanguage: 'English',
        chapters: [{ number: 1, title: 'C1', content: '<p></p>' }],
      },
    ]);
    const empty = ids.fr as string;
    const est = await auth(http().get(`/admin/versions/${empty}/drafts/analysis/estimate`)).expect(
      409,
    );
    expect(est.body.code).toBe('SOURCE_HAS_NO_CHAPTERS');
    const opsBefore = await prisma.llmOperation.count();
    const res = await start(empty, 'analysis').expect(409);
    expect(res.body.code).toBe('SOURCE_HAS_NO_CHAPTERS');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: empty } })).toBe(0);
    expect(await prisma.llmOperation.count()).toBe(opsBefore);
  });

  it('analysis without a saved analysis: built, analysisUpdatedAt null, nothing written to BookAnalysis (F05-11, Р15)', async () => {
    const versionId = await sourceBook();
    answer = (name) =>
      name === 'analysis_draft'
        ? {
            facts: { settingPlace: '', settingTime: '', narrator: '', structure: '' },
            characters: [],
            keyQuotes: [{ text: 'Anna in chapter 3.', chapter: 3, speakerKey: '' }],
            style: [],
          }
        : defaultAnswer(name);
    await start(versionId, 'analysis').expect(202);
    await drain();
    const res = await auth(http().get(`/admin/versions/${versionId}/drafts/analysis`)).expect(200);
    const draft = (res.body as { draft: DraftBody & Record<string, unknown> }).draft;
    expect(draft.status).toBe('ready');
    expect(draft.analysisUpdatedAt).toBeNull();
    expect(draft.analysis).toEqual({
      language: 'en',
      keyQuotes: [{ text: 'Anna in chapter 3.', chapter: 3 }],
    });
    expect(draft.droppedQuotes).toEqual([]);
    expect(await prisma.bookAnalysis.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('analysis: source edited after the dossier - 409 DOSSIER_STALE on estimate and start, no draft (F05-11)', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    await prisma.chapter.updateMany({
      where: { bookVersionId: versionId, number: 2 },
      data: { content: '<p>Edited.</p>' },
    });
    const est = await auth(
      http().get(`/admin/versions/${versionId}/drafts/analysis/estimate`),
    ).expect(409);
    expect(est.body.code).toBe('DOSSIER_STALE');
    const res = await start(versionId, 'analysis').expect(409);
    expect(res.body.code).toBe('DOSSIER_STALE');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('analysis estimate: the dossier line carries the start refusal of the dossier estimate (T151)', async () => {
    const versionId = await sourceBook();
    const dossiers = app.get<DossierDemandService>(DossierDemandService);
    const real: DossierDemandService['contextEstimate'] = (...args) =>
      DossierDemandService.prototype.contextEstimate.apply(
        dossiers,
        args,
      ) as Promise<ContextEstimate>;
    jest
      .spyOn(dossiers, 'contextEstimate')
      .mockImplementationOnce(
        async (...args: Parameters<DossierDemandService['contextEstimate']>) => {
          const estimate = await real(...args);
          expect(estimate.dossier).not.toBeNull();
          return {
            ...estimate,
            dossier: estimate.dossier && { ...estimate.dossier, refusedTooLong: true },
          };
        },
      );

    const res = await auth(
      http().get(`/admin/versions/${versionId}/drafts/analysis/estimate`),
    ).expect(200);
    expect(res.body.dossier).toMatchObject({ refusedTooLong: true, upperBound: false });
  });

  it('analysis start refused 409 DOSSIER_TOO_LONG when the dossier estimate is refused; nothing is created and the ready draft of the kind stays (T153)', async () => {
    const versionId = await sourceBook();
    await start(versionId, 'analysis').expect(202);
    await drain();
    expect((await draftOf(versionId, 'analysis')).status).toBe('ready');
    const drafts = await prisma.contentDraft.count({ where: { bookVersionId: versionId } });
    const operations = await prisma.llmOperation.count({ where: { bookVersionId: versionId } });
    const dossiers = app.get<DossierDemandService>(DossierDemandService);
    const real: DossierDemandService['contextEstimate'] = (...args) =>
      DossierDemandService.prototype.contextEstimate.apply(
        dossiers,
        args,
      ) as Promise<ContextEstimate>;
    const refused = jest
      .spyOn(dossiers, 'contextEstimate')
      .mockImplementation(async (...args: Parameters<DossierDemandService['contextEstimate']>) => {
        const estimate = await real(...args);
        return {
          ...estimate,
          dossier: {
            estimateUsd: new Prisma.Decimal(1),
            suggestedLimitUsd: new Prisma.Decimal(2),
            upperBound: false,
            refusedTooLong: true,
            sourceVersionId: versionId,
            chapters: 3,
            parts: 1,
          },
        };
      });

    const res = await start(versionId, 'analysis').expect(409);
    expect(res.body).toMatchObject({ code: 'DOSSIER_TOO_LONG' });
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(drafts);
    expect(
      await prisma.contentDraft.count({ where: { bookVersionId: versionId, status: 'discarded' } }),
    ).toBe(0);
    expect(await prisma.llmOperation.count({ where: { bookVersionId: versionId } })).toBe(
      operations,
    );
    expect((await draftOf(versionId, 'analysis')).status).toBe('ready');

    // Оценка без отказа - старт проходит: проверка не задевает остальные книги.
    refused.mockRestore();
    await start(versionId, 'analysis').expect(202);
    await drain();
  });

  it('analysis on the source without a dossier: the dossier is built first and the draft waits for it; no glossary in the dossier language', async () => {
    const versionId = await sourceBook();
    const estimate = await auth(
      http().get(`/admin/versions/${versionId}/drafts/analysis/estimate`),
    ).expect(200);
    expect(estimate.body.dossier).not.toBeNull();
    // Версия на языке досье: глоссария нет ни в оценке, ни в стройке (В6).
    expect(estimate.body.glossary).toBeNull();

    const started = await start(versionId, 'analysis').expect(202);
    expect(started.body.status).toBe('building');
    // Строится досье: заготовка ждёт его (Р5).
    await worker.runOnce();
    expect((await draftOf(versionId, 'analysis')).waitingFor).toBe('dossier');
    await drain();

    const draft = await draftOf(versionId, 'analysis');
    expect(draft).toMatchObject({ status: 'ready', waitingFor: null });
    expect(callsOf('analysis_draft')).toHaveLength(1);
    expect(callsOf('glossary')).toHaveLength(0);
    expect(
      await prisma.bookGlossary.count({ where: { dossier: { sourceVersionId: versionId } } }),
    ).toBe(0);
  });

  it('analysis on a manual version in another language without a glossary: the glossary is built first, the draft waits for it, names by that glossary', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS },
      { language: 'fr', originalLanguage: 'English', chapters: THREE_CHAPTERS },
    ]);
    const manual = ids.fr as string;
    await buildDossier(ids.en as string);
    await start(manual, 'analysis').expect(202);
    await worker.runOnce();
    expect((await draftOf(manual, 'analysis')).waitingFor).toBe('glossary');
    await drain();
    expect(callsOf('glossary')).toHaveLength(1);
    expect((await draftOf(manual, 'analysis')).status).toBe('ready');
    expect(callsOf('analysis_draft')[0].body.messages[1].content).toContain('Annette');
  });

  it('analysis ceiling: reached at entry - 409 without a draft or operation; reached on the way - paused, the draft stays building', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const opsBefore = await prisma.llmOperation.count({
      where: { bookVersionId: versionId, kind: 'draft' },
    });
    await prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 1, spentUsd: 1 },
    });
    const refused = await start(versionId, 'analysis').expect(409);
    expect(refused.body.code).toBe('LLM_CEILING_REACHED');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(
      await prisma.llmOperation.count({ where: { bookVersionId: versionId, kind: 'draft' } }),
    ).toBe(opsBefore);

    await resetBudget();
    await start(versionId, 'analysis').expect(202);
    // Потолок кончился после старта: первый же вызов не резервируется.
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    const draft = await draftOf(versionId, 'analysis');
    expect(draft.status).toBe('building');
    expect(draft.operation).toMatchObject({ status: 'paused', pauseReason: 'CEILING_REACHED' });
    expect(callsOf('analysis_draft')).toHaveLength(0);
  });

  it('analysis repeat: a second start while building - 409 DRAFT_IN_PROGRESS; a start after ready discards the previous', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const first = await start(versionId, 'analysis').expect(202);
    expect((await start(versionId, 'analysis').expect(409)).body.code).toBe('DRAFT_IN_PROGRESS');
    await drain();
    const second = await start(versionId, 'analysis').expect(202);
    const rows = await prisma.contentDraft.findMany({ where: { bookVersionId: versionId } });
    expect(rows.find((r) => r.id === first.body.id)?.status).toBe('discarded');
    expect(rows.find((r) => r.id === second.body.id)?.status).toBe('building');
  });

  it('analysis discard while building cancels the operation; an answer after the discard does not bring the draft back', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const started = await start(versionId, 'analysis').expect(202);
    const id = started.body.id as string;
    // Ответ модели приходит уже после «discard»: запись итога идёт условием `building`.
    answer = async (name) => {
      if (name === 'analysis_draft') {
        await prisma.contentDraft.update({ where: { id }, data: { status: 'discarded' } });
      }
      return defaultAnswer(name);
    };
    await drain();
    expect(callsOf('analysis_draft')).toHaveLength(1);
    const late = await prisma.contentDraft.findUniqueOrThrow({ where: { id } });
    expect(late.status).toBe('discarded');
    expect(late.data).toBeNull();

    answer = (name) => defaultAnswer(name);
    const other = await start(versionId, 'analysis').expect(202);
    const discarded = await auth(
      http().post(`/admin/content-drafts/${other.body.id as string}/discard`),
    ).expect(200);
    expect(discarded.body.status).toBe('discarded');
    expect(discarded.body.operation.status).toBe('cancelled');
    expect(await latest(versionId, 'analysis')).toBeNull();
  });

  it('analysis final refusals: an answer off the form twice, the dossier gone before the step - failed with the reason, the operation failed, a new start is open', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const failedOf = async () => {
      const row = await prisma.contentDraft.findFirstOrThrow({
        where: { bookVersionId: versionId, kind: 'analysis' },
        include: { operation: true },
        orderBy: { createdAt: 'desc' },
      });
      return { status: row.status, failedReason: row.failedReason, op: row.operation.status };
    };

    // Ответ не по форме дважды (с замечанием) - окончательный отказ.
    answer = (name) => (name === 'analysis_draft' ? { wrong: true } : defaultAnswer(name));
    await start(versionId, 'analysis').expect(202);
    await drain();
    expect(callsOf('analysis_draft')).toHaveLength(2);
    expect(await failedOf()).toEqual({
      status: 'failed',
      failedReason: 'DRAFT_INVALID_RESPONSE',
      op: 'failed',
    });

    // Досье заготовки пропало между стартом и шагом.
    answer = (name) => defaultAnswer(name);
    calls.length = 0;
    const started = await start(versionId, 'analysis').expect(202);
    await prisma.contentDraft.update({
      where: { id: started.body.id as string },
      data: { dossierId: randomUUID() },
    });
    await drain();
    expect(await failedOf()).toEqual({
      status: 'failed',
      failedReason: 'DRAFT_INPUT_MISSING',
      op: 'failed',
    });
    expect(callsOf('analysis_draft')).toHaveLength(0);
    // Упавшая заготовка нового старта не держит: индекс - только на `building`.
    expect(await latest(versionId, 'analysis')).toMatchObject({ status: 'failed' });
    await start(versionId, 'analysis').expect(202);
  });

  it('analysis step restarted after a crash: the answer written before the crash is not paid for again', async () => {
    const versionId = await sourceBook();
    const started = await start(versionId, 'analysis').expect(202);
    // Ответ записан до обрыва шага (запись идёт до итога шага).
    const saved = {
      analysis: { language: 'en', keyQuotes: [{ text: 'Anna in chapter 1.', chapter: 1 }] },
      droppedQuotes: [],
      motifs: [],
      dossierLanguage: 'en',
      analysisUpdatedAt: null,
    };
    await prisma.contentDraft.update({
      where: { id: started.body.id as string },
      data: { data: saved },
    });
    await drain();
    expect(callsOf('analysis_draft')).toHaveLength(0);
    const res = await auth(http().get(`/admin/versions/${versionId}/drafts/analysis`)).expect(200);
    const draft = (res.body as { draft: DraftBody & Record<string, unknown> }).draft;
    expect(draft).toMatchObject({ id: started.body.id as string, status: 'ready' });
    expect(draft.analysis).toEqual(saved.analysis);
  });

  it('analysis cancel from the operations page - failed DRAFT_CANCELLED; resume after a pause finishes the draft', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const first = await start(versionId, 'analysis').expect(202);
    await auth(
      http().post(`/admin/llm/operations/${first.body.operation.id as string}/cancel`),
    ).expect(200);
    expect(await draftOf(versionId, 'analysis')).toMatchObject({
      status: 'failed',
      operation: { status: 'cancelled' },
    });
    const row = await prisma.contentDraft.findUniqueOrThrow({
      where: { id: first.body.id as string },
    });
    expect(row.failedReason).toBe('DRAFT_CANCELLED');

    // Пауза по потолку по ходу, потолок подняли - «продолжить» доводит заготовку.
    const second = await start(versionId, 'analysis').expect(202);
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    expect((await draftOf(versionId, 'analysis')).operation.status).toBe('paused');
    await resetBudget();
    await auth(http().post(`/admin/llm/operations/${second.body.operation.id as string}/resume`))
      .send({})
      .expect(200);
    await drain();
    expect(await draftOf(versionId, 'analysis')).toMatchObject({
      id: second.body.id as string,
      status: 'ready',
    });
    expect(callsOf('analysis_draft')).toHaveLength(1);
  });

  /** Строящаяся строка вида с операцией `draft` и `pending`-задачей `content_draft`, как от старта. */
  const buildingRow = async (
    versionId: string,
    kind: 'analysis' | (typeof RETIRED_KINDS)[number],
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

  it('drain at start (F06-3, А1): building rows of retired kinds - discarded, their active and paused operations and pending tasks cancelled; analysis of the same version untouched; a repeat changes nothing', async () => {
    const versionId = await sourceBook();
    const sections = await buildingRow(versionId, 'summary_sections', 'active');
    const full = await buildingRow(versionId, 'summary_full', 'paused');
    const analysis = await buildingRow(versionId, 'analysis', 'active');
    const drafts = app.get(ContentDraftService);

    expect(await drafts.drainRetiredSummaryDrafts()).toBe(2);
    for (const retired of [sections, full]) {
      expect(await stateOf(retired)).toEqual({
        row: 'discarded',
        op: 'cancelled',
        task: 'cancelled',
      });
    }
    expect(await stateOf(analysis)).toEqual({ row: 'building', op: 'active', task: 'pending' });

    // Повтор: строк снятых видов в `building` нет - ничего не меняется.
    const snapshot = await prisma.contentDraft.findMany({
      where: { bookVersionId: versionId },
      include: { operation: { include: { tasks: true } } },
      orderBy: { createdAt: 'asc' },
    });
    expect(await drafts.drainRetiredSummaryDrafts()).toBe(0);
    expect(
      await prisma.contentDraft.findMany({
        where: { bookVersionId: versionId },
        include: { operation: { include: { tasks: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ).toEqual(snapshot);
    expect(calls).toHaveLength(0);

    // Строящийся анализ без настоящего старта не остаётся висеть на следующие наборы.
    await auth(http().post(`/admin/content-drafts/${analysis.rowId}/discard`)).expect(200);
  });

  it('a task of a retired-kind row taken by the worker (F06-3, А1): the row discarded, its operation cancelled, the model not called, the row not failed', async () => {
    const versionId = await sourceBook();
    const retired = await buildingRow(versionId, 'summary_brief', 'active');
    await drain();
    expect(calls).toHaveLength(0);
    // Задачу взял обработчик (шаг завершён `done`), а не отменил дренаж.
    expect(await stateOf(retired)).toEqual({ row: 'discarded', op: 'cancelled', task: 'done' });
    const row = await prisma.contentDraft.findUniqueOrThrow({ where: { id: retired.rowId } });
    expect(row.failedReason).toBeNull();
  });

  it('no token - 401; an unknown version - 404', async () => {
    await http().get(`/admin/versions/${randomUUID()}/drafts/analysis`).expect(401);
    await auth(http().get(`/admin/versions/${randomUUID()}/drafts/analysis/estimate`)).expect(404);
    await auth(http().post(`/admin/versions/${randomUUID()}/drafts/analysis`))
      .send({})
      .expect(404);
  });
});
