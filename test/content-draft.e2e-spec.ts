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
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-10: заготовка Summary из досье. Построение идёт настоящим исполнителем на базе: его
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
  /** План: раздел 1 - глава 1, раздел 2 - главы 2-3 (номер читалки - первая, 2). */
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
  const SECTION = {
    title: 'Chapter 1',
    text: 'Anna arrives.\n\nShe stays.',
    additions: 'none',
    question: 'none',
  };
  const FULL = { text: 'Opening.\n\n## Part One\n\nAnna <b>arrives</b>.', question: 'none' };

  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm', string> = { admin: '', cm: '' };
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
      summary_section: SECTION,
      summary_full: FULL,
      summary_brief: { text: 'In brief.', question: 'none' },
    })[name];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' = 'admin') =>
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
    plannedSections: number | null;
    sections: Array<Record<string, unknown>> | null;
    text: string | null;
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
    for (const email of [adminEmail, cmEmail]) {
      await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
    }
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    for (const [who, email] of [
      ['admin', adminEmail],
      ['cm', cmEmail],
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
        const name = body.response_format?.json_schema?.name ?? '';
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

  it('access: admin only; analysis is not a kind of this batch', async () => {
    const versionId = await sourceBook();
    for (const [method, path] of [
      ['get', `/admin/versions/${versionId}/drafts/summary_sections/estimate`],
      ['get', `/admin/versions/${versionId}/drafts/summary_sections`],
      ['post', `/admin/versions/${versionId}/drafts/summary_sections`],
      ['post', `/admin/content-drafts/${versionId}/discard`],
    ] as Array<['get' | 'post', string]>) {
      await auth(http()[method](path), 'cm').expect(403);
    }
    await auth(http().get(`/admin/versions/${versionId}/drafts/analysis`)).expect(400);
    expect(await latest(versionId, 'summary_sections')).toBeNull();
  });

  it('sections on the source: the dossier is built first, no glossary in the dossier language, saved summary untouched', async () => {
    const versionId = await sourceBook();
    const estimate = await auth(
      http().get(`/admin/versions/${versionId}/drafts/summary_sections/estimate`),
    ).expect(200);
    expect(estimate.body.dossier).not.toBeNull();
    // Версия на языке досье: глоссария нет ни в оценке, ни в стройке (В6).
    expect(estimate.body.glossary).toBeNull();
    expect(estimate.body.upperBound).toBe(true);

    const started = await start(versionId, 'summary_sections').expect(202);
    expect(started.body.status).toBe('building');
    // Строится досье: заготовка ждёт его (Р5).
    await worker.runOnce();
    expect((await draftOf(versionId, 'summary_sections')).waitingFor).toBe('dossier');
    await drain();

    const draft = await draftOf(versionId, 'summary_sections');
    expect(draft.status).toBe('ready');
    expect(draft.plannedSections).toBe(2);
    expect(draft.sections).toEqual([
      expect.objectContaining({
        number: 1,
        readerChapter: 1,
        readerChapterMissing: false,
        text: '<p>Anna arrives.</p><p>She stays.</p>',
        question: null,
      }),
      expect.objectContaining({ number: 2, readerChapter: 2, readerChapterMissing: false }),
    ]);
    // Раздел 2 - текст обеих глав плана, по метке главы читалки.
    const second = callsOf('summary_section')[1].body.messages[1].content;
    expect(second).toContain('[READER CHAPTER 2]');
    expect(second).toContain('[READER CHAPTER 3]');
    expect(second).not.toContain('[READER CHAPTER 1]');
    expect(callsOf('glossary')).toHaveLength(0);
    expect(
      await prisma.bookGlossary.count({ where: { dossier: { sourceVersionId: versionId } } }),
    ).toBe(0);
    // Заготовка не пишет в пересказ версии.
    expect(await prisma.bookSummarySection.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(await prisma.bookSummary.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('source edited after the dossier: 409 DOSSIER_STALE on estimate and start', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    await prisma.chapter.updateMany({
      where: { bookVersionId: versionId, number: 1 },
      data: { content: '<p>Anna in chapter 1, edited.</p>' },
    });
    const est = await auth(
      http().get(`/admin/versions/${versionId}/drafts/summary_sections/estimate`),
    ).expect(409);
    expect(est.body.code).toBe('DOSSIER_STALE');
    const res = await start(versionId, 'summary_sections').expect(409);
    expect(res.body.code).toBe('DOSSIER_STALE');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('translated version: the dossier and glossary of its run, no freshness check, names by the run glossary (Р18)', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS },
      { language: 'fr', originalLanguage: 'English', chapters: THREE_CHAPTERS },
    ]);
    const source = ids.en as string;
    const translated = ids.fr as string;
    const dossier = await buildDossier(source);
    const glossary = await prisma.bookGlossary.create({
      data: { dossierId: dossier.id, language: 'fr', status: 'ready', data: GLOSSARY },
    });
    const op = await prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: new Prisma.Decimal(1), status: 'done' },
    });
    await prisma.translationRun.create({
      data: {
        operationId: op.id,
        bookVersionId: source,
        sourceLanguage: 'en',
        dossierId: dossier.id,
        languages: {
          create: [
            { language: 'fr', glossaryId: glossary.id, status: 'done', bookVersionId: translated },
          ],
        },
      },
    });
    // Исходник правлен после досье запуска: переведённой версии это не мешает.
    await prisma.chapter.updateMany({
      where: { bookVersionId: source, number: 1 },
      data: { content: '<p>Edited source.</p>' },
    });
    // У исходника уже новое поколение досье, без глоссария `fr`: переведённая версия его не берёт.
    const fresh = await buildDossier(source);
    expect(fresh.id).not.toBe(dossier.id);
    const dossiersBefore = await prisma.bookDossier.count({ where: { sourceVersionId: source } });

    const estimate = await auth(
      http().get(`/admin/versions/${translated}/drafts/summary_sections/estimate`),
    ).expect(200);
    expect(estimate.body).toMatchObject({
      dossier: null,
      glossary: null,
      sections: 2,
      upperBound: false,
    });
    const started = await start(translated, 'summary_sections').expect(202);
    expect(started.body.language).toBe('fr');
    await drain();

    const row = await prisma.contentDraft.findFirstOrThrow({
      where: { bookVersionId: translated },
    });
    expect(row).toMatchObject({ status: 'ready', dossierId: dossier.id, glossaryId: glossary.id });
    const prompt = callsOf('summary_section')[0].body.messages[1].content;
    expect(prompt).toContain('Annette');
    expect(callsOf('summary_section')[0].body.messages[0].content).toContain('French');
    expect(await prisma.bookDossier.count({ where: { sourceVersionId: source } })).toBe(
      dossiersBefore,
    );
    expect(await prisma.bookGlossary.count({ where: { dossierId: dossier.id } })).toBe(1);
    expect(await prisma.bookGlossary.count({ where: { dossierId: fresh.id } })).toBe(0);
  });

  it('manual version in another language without a glossary: the glossary is built first; a plan chapter missing in the version - null with a mark', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS },
      // Ручная версия без главы 2: номер читалки раздела 2 не подтягивается к главе 3 (В5).
      {
        language: 'fr',
        originalLanguage: 'English',
        chapters: THREE_CHAPTERS.filter((c) => c.number !== 2),
      },
    ]);
    const manual = ids.fr as string;
    await buildDossier(ids.en as string);
    const estimate = await auth(
      http().get(`/admin/versions/${manual}/drafts/summary_sections/estimate`),
    ).expect(200);
    expect(estimate.body.dossier).toBeNull();
    expect(estimate.body.glossary).not.toBeNull();

    await start(manual, 'summary_sections').expect(202);
    await worker.runOnce();
    expect((await draftOf(manual, 'summary_sections')).waitingFor).toBe('glossary');
    await drain();
    expect(callsOf('glossary')).toHaveLength(1);
    const draft = await draftOf(manual, 'summary_sections');
    expect(draft.status).toBe('ready');
    expect(draft.sections?.[1]).toMatchObject({
      number: 2,
      readerChapter: null,
      readerChapterMissing: true,
    });
    expect(callsOf('summary_section')[0].body.messages[1].content).toContain('Annette');
  });

  it('ceiling: reached at entry - 409 without a draft or operation; reached on the way - paused, the draft stays building', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const opsBefore = await prisma.llmOperation.count({
      where: { bookVersionId: versionId, kind: 'draft' },
    });
    await prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 1, spentUsd: 1 },
    });
    const refused = await start(versionId, 'summary_sections').expect(409);
    expect(refused.body.code).toBe('LLM_CEILING_REACHED');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(
      await prisma.llmOperation.count({ where: { bookVersionId: versionId, kind: 'draft' } }),
    ).toBe(opsBefore);

    await resetBudget();
    await start(versionId, 'summary_sections').expect(202);
    // Потолок кончился после старта: первый же вызов не резервируется.
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    const draft = await draftOf(versionId, 'summary_sections');
    expect(draft.status).toBe('building');
    expect(draft.operation).toMatchObject({ status: 'paused', pauseReason: 'CEILING_REACHED' });
    expect(callsOf('summary_section')).toHaveLength(0);
  });

  it('full and brief: 409 without saved input, built only from what the editor saved', async () => {
    const versionId = await sourceBook();
    expect((await start(versionId, 'summary_full').expect(409)).body.code).toBe(
      'SUMMARY_SECTIONS_MISSING',
    );
    // Пустой редактор (`<p></p>`) сохранённым разделом не считается (В4).
    await prisma.bookSummarySection.create({
      data: { bookVersionId: versionId, number: 1, title: 'Empty', text: '<p></p>' },
    });
    expect((await start(versionId, 'summary_full').expect(409)).body.code).toBe(
      'SUMMARY_SECTIONS_MISSING',
    );
    await prisma.bookSummarySection.create({
      data: {
        bookVersionId: versionId,
        number: 2,
        title: 'Saved',
        text: '<p>Edited by the editor.</p>',
      },
    });
    await start(versionId, 'summary_full').expect(202);
    await drain();
    const full = await draftOf(versionId, 'summary_full');
    expect(full.status).toBe('ready');
    // Разметка модели не переносится: `<b>` - текстом, подзаголовок `## ` - `h2`.
    expect(full.text).toBe(
      '<p>Opening.</p><h2>Part One</h2><p>Anna &lt;b&gt;arrives&lt;/b&gt;.</p>',
    );
    expect(callsOf('summary_full')[0].body.messages[1].content).toContain('Edited by the editor.');
    expect(callsOf('summary_full')[0].body.messages[1].content).not.toContain('Empty');
    // Полный не сохранён - очень краткому не из чего.
    expect((await start(versionId, 'summary_brief').expect(409)).body.code).toBe(
      'SUMMARY_FULL_MISSING',
    );
    expect(await prisma.bookSummary.count({ where: { bookVersionId: versionId } })).toBe(0);
    await prisma.bookSummary.create({
      data: { bookVersionId: versionId, summary: '<p>Saved full.</p>' },
    });
    await start(versionId, 'summary_brief').expect(202);
    await drain();
    expect((await draftOf(versionId, 'summary_brief')).text).toBe('<p>In brief.</p>');
    expect(callsOf('summary_brief')[0].body.messages[1].content).toContain('Saved full.');
    expect(
      (await prisma.bookSummary.findUniqueOrThrow({ where: { bookVersionId: versionId } })).brief,
    ).toBeNull();
  });

  it('repeat: a second start while building - 409 DRAFT_IN_PROGRESS; a start after ready discards the previous', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const first = await start(versionId, 'summary_sections').expect(202);
    expect((await start(versionId, 'summary_sections').expect(409)).body.code).toBe(
      'DRAFT_IN_PROGRESS',
    );
    await drain();
    const second = await start(versionId, 'summary_sections').expect(202);
    const rows = await prisma.contentDraft.findMany({ where: { bookVersionId: versionId } });
    expect(rows.find((r) => r.id === first.body.id)?.status).toBe('discarded');
    expect(rows.find((r) => r.id === second.body.id)?.status).toBe('building');
  });

  it('discard while building cancels the operation; an answer after the discard does not bring the draft back', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const started = await start(versionId, 'summary_sections').expect(202);
    const id = started.body.id as string;
    // Ответ модели приходит уже после «discard»: запись итога идёт условием `building`.
    answer = async (name) => {
      if (name === 'summary_section') {
        await prisma.contentDraft.update({ where: { id }, data: { status: 'discarded' } });
      }
      return defaultAnswer(name);
    };
    await drain();
    const late = await prisma.contentDraft.findUniqueOrThrow({ where: { id } });
    expect(late.status).toBe('discarded');
    expect(late.data).toBeNull();

    answer = (name) => defaultAnswer(name);
    const other = await start(versionId, 'summary_sections').expect(202);
    const discarded = await auth(
      http().post(`/admin/content-drafts/${other.body.id as string}/discard`),
    ).expect(200);
    expect(discarded.body.status).toBe('discarded');
    expect(discarded.body.operation.status).toBe('cancelled');
    expect(await latest(versionId, 'summary_sections')).toBeNull();
  });
  it('limit below the dossier built first - 400 DRAFT_LIMIT_TOO_LOW without a draft', async () => {
    const versionId = await sourceBook();
    const res = await start(versionId, 'summary_sections', { limitUsd: '0.00000001' }).expect(400);
    expect(res.body.code).toBe('DRAFT_LIMIT_TOO_LOW');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('final refusals: no plan, empty answer, saved input gone - failed with the reason, the operation failed, a new start is open', async () => {
    const versionId = await sourceBook();
    const dossier = await buildDossier(versionId);
    const failedOf = async (kind: string) => {
      const row = await prisma.contentDraft.findFirstOrThrow({
        where: { bookVersionId: versionId, kind: kind as 'summary_sections' },
        include: { operation: true },
        orderBy: { createdAt: 'desc' },
      });
      return { status: row.status, failedReason: row.failedReason, op: row.operation.status };
    };

    // В досье нет плана разделов.
    await prisma.bookDossier.update({
      where: { id: dossier.id },
      data: { data: { ...DOSSIER, summaryPlan: [] } },
    });
    await start(versionId, 'summary_sections').expect(202);
    await drain();
    expect(await failedOf('summary_sections')).toEqual({
      status: 'failed',
      failedReason: 'DRAFT_NO_PLAN',
      op: 'failed',
    });
    expect(callsOf('summary_section')).toHaveLength(0);

    // Ответ по форме, но без текста: не раздел (пустая карточка «без текста» ушла бы в форму).
    await prisma.bookDossier.update({ where: { id: dossier.id }, data: { data: DOSSIER } });
    answer = (name) =>
      name === 'summary_section'
        ? { title: 'T', text: ' \n\n ', additions: 'none', question: 'none' }
        : defaultAnswer(name);
    await start(versionId, 'summary_sections').expect(202);
    await drain();
    expect(await failedOf('summary_sections')).toEqual({
      status: 'failed',
      failedReason: 'DRAFT_INVALID_RESPONSE',
      op: 'failed',
    });

    // Ответ не по форме дважды (с замечанием) - тот же отказ.
    answer = (name) => (name === 'summary_full' ? { question: 'none' } : defaultAnswer(name));
    await prisma.bookSummarySection.create({
      data: { bookVersionId: versionId, number: 1, title: 'Saved', text: '<p>Saved text.</p>' },
    });
    await start(versionId, 'summary_full').expect(202);
    await drain();
    expect(callsOf('summary_full')).toHaveLength(2);
    expect(await failedOf('summary_full')).toMatchObject({
      failedReason: 'DRAFT_INVALID_RESPONSE',
    });

    // Сохранённые разделы удалили между стартом и шагом.
    answer = (name) => defaultAnswer(name);
    await start(versionId, 'summary_full').expect(202);
    await prisma.bookSummarySection.deleteMany({ where: { bookVersionId: versionId } });
    await drain();
    expect(await failedOf('summary_full')).toMatchObject({
      status: 'failed',
      failedReason: 'DRAFT_INPUT_MISSING',
    });
    // Упавшая заготовка нового старта не держит: индекс - только на `building`.
    expect(await latest(versionId, 'summary_sections')).toMatchObject({ status: 'failed' });
    await start(versionId, 'summary_sections').expect(202);
  });

  it('chapters of a section without visible text - the model is not called, the card is empty', async () => {
    const { ids } = await book([
      {
        language: 'en',
        originalLanguage: 'English',
        chapters: [
          THREE_CHAPTERS[0],
          { number: 2, title: 'C2', content: '<p></p><p>&nbsp;</p>' },
          {
            number: 3,
            title: 'C3',
            content: '<figure><img src="https://example.com/a.jpg"></figure>',
          },
        ],
      },
    ]);
    const versionId = ids.en as string;
    await buildDossier(versionId);
    await start(versionId, 'summary_sections').expect(202);
    await drain();
    const draft = await draftOf(versionId, 'summary_sections');
    expect(draft.status).toBe('ready');
    expect(callsOf('summary_section')).toHaveLength(1);
    expect(draft.sections?.[1]).toMatchObject({ number: 2, text: '' });
  });

  it('a step restarted after a crash does not pay for a saved section again', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const started = await start(versionId, 'summary_sections').expect(202);
    // Раздел 1 сохранён до обрыва шага (запись идёт до итога шага).
    const saved = {
      number: 1,
      title: 'Saved before the crash',
      text: '<p>Saved.</p>',
      readerChapter: 1,
      readerChapterMissing: false,
      additions: null,
      question: null,
    };
    await prisma.contentDraft.update({
      where: { id: started.body.id as string },
      data: { data: { plannedSections: 2, sections: [saved] } },
    });
    await drain();
    expect(callsOf('summary_section')).toHaveLength(1);
    expect(callsOf('summary_section')[0].body.messages[1].content).toContain('Section 2');
    const draft = await draftOf(versionId, 'summary_sections');
    expect(draft.status).toBe('ready');
    expect(draft.sections?.[0]).toEqual(saved);
  });

  it('cancel from the operations page - failed DRAFT_CANCELLED; resume after a pause finishes the draft', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const first = await start(versionId, 'summary_sections').expect(202);
    await auth(
      http().post(`/admin/llm/operations/${first.body.operation.id as string}/cancel`),
    ).expect(200);
    expect(await draftOf(versionId, 'summary_sections')).toMatchObject({
      status: 'failed',
      operation: { status: 'cancelled' },
    });
    const row = await prisma.contentDraft.findUniqueOrThrow({
      where: { id: first.body.id as string },
    });
    expect(row.failedReason).toBe('DRAFT_CANCELLED');

    // Пауза по потолку по ходу, потолок подняли - «продолжить» доводит заготовку.
    const second = await start(versionId, 'summary_sections').expect(202);
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    expect((await draftOf(versionId, 'summary_sections')).operation.status).toBe('paused');
    await resetBudget();
    await auth(http().post(`/admin/llm/operations/${second.body.operation.id as string}/resume`))
      .send({})
      .expect(200);
    await drain();
    expect(await draftOf(versionId, 'summary_sections')).toMatchObject({
      id: second.body.id as string,
      status: 'ready',
    });
    expect(callsOf('summary_section')).toHaveLength(2);
  });
  it('added marks: once per section, repeat is a no-op, unknown section 400, not ready 409', async () => {
    const versionId = await sourceBook();
    await buildDossier(versionId);
    const started = await start(versionId, 'summary_sections').expect(202);
    const id = started.body.id as string;
    // Строится - отметок нет.
    expect(
      (await auth(http().post(`/admin/content-drafts/${id}/sections/1/added`)).expect(409)).body
        .code,
    ).toBe('DRAFT_NOT_READY');
    await drain();
    await auth(http().post(`/admin/content-drafts/${id}/sections/2/added`)).expect(200);
    await auth(http().post(`/admin/content-drafts/${id}/sections/2/added`)).expect(200);
    const marked = await auth(http().post(`/admin/content-drafts/${id}/sections/1/added`)).expect(
      200,
    );
    expect(marked.body.addedSections).toEqual([2, 1]);
    expect(
      (await auth(http().post(`/admin/content-drafts/${id}/sections/9/added`)).expect(400)).body
        .code,
    ).toBe('DRAFT_SECTION_UNKNOWN');
    // Отметки живут в заготовке: после «перезагрузки» GET отдаёт их же.
    expect(
      ((await draftOf(versionId, 'summary_sections')) as unknown as { addedSections: number[] })
        .addedSections,
    ).toEqual([2, 1]);
    await auth(http().post(`/admin/content-drafts/${id}/sections/1/added`), 'cm').expect(403);
  });

  it('translated version: its run still writing - 409 RUN_LANGUAGE_UNFINISHED; a failed run - the run dossier (Р18); the run dossier gone - DRAFT_DOSSIER_MISSING', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: THREE_CHAPTERS },
      { language: 'fr', originalLanguage: 'English', chapters: THREE_CHAPTERS },
    ]);
    const source = ids.en as string;
    const translated = ids.fr as string;
    const dossier = await buildDossier(source);
    const glossary = await prisma.bookGlossary.create({
      data: { dossierId: dossier.id, language: 'fr', status: 'ready', data: GLOSSARY },
    });
    const op = await prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: new Prisma.Decimal(1), status: 'active' },
    });
    const run = await prisma.translationRun.create({
      data: {
        operationId: op.id,
        bookVersionId: source,
        sourceLanguage: 'en',
        dossierId: dossier.id,
        languages: {
          create: [
            {
              language: 'fr',
              glossaryId: glossary.id,
              status: 'running',
              bookVersionId: translated,
            },
          ],
        },
      },
    });
    const estimate = await auth(
      http().get(`/admin/versions/${translated}/drafts/summary_sections/estimate`),
    ).expect(409);
    expect(estimate.body.code).toBe('RUN_LANGUAGE_UNFINISHED');
    expect((await start(translated, 'summary_sections').expect(409)).body.code).toBe(
      'RUN_LANGUAGE_UNFINISHED',
    );
    await prisma.translationRunLanguage.updateMany({
      where: { runId: run.id },
      data: { status: 'failed' },
    });
    await start(translated, 'summary_sections').expect(202);
    const row = await prisma.contentDraft.findFirstOrThrow({
      where: { bookVersionId: translated },
    });
    expect(row).toMatchObject({ dossierId: dossier.id, glossaryId: glossary.id });
    await prisma.contentDraft.updateMany({
      where: { bookVersionId: translated },
      data: { status: 'discarded' },
    });
    await prisma.translationRun.update({ where: { id: run.id }, data: { dossierId: null } });
    const gone = await auth(
      http().get(`/admin/versions/${translated}/drafts/summary_sections/estimate`),
    ).expect(409);
    expect(gone.body.code).toBe('DRAFT_DOSSIER_MISSING');
  });

  it('no token - 401; an unknown version - 404', async () => {
    await http().get(`/admin/versions/${randomUUID()}/drafts/summary_full`).expect(401);
    await auth(http().get(`/admin/versions/${randomUUID()}/drafts/summary_full/estimate`)).expect(
      404,
    );
    await auth(http().post(`/admin/versions/${randomUUID()}/drafts/summary_full`))
      .send({})
      .expect(404);
  });
});
