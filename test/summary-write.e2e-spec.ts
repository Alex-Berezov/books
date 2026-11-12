/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F06-2: ход пересказа «Write Summary» - разделы плана досье → полный → «Очень кратко», запись
 * в поля под условием, предложения, «Accept», «Regenerate», пауза и «Continue». Исполнитель на
 * базе, проходы руками (ключа на старте нет, Р25); внешний `fetch` подменён, ответ модели - по
 * имени схемы ответа.
 */
describe('Summary run «Write Summary» (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const DOSSIER_MODEL = 'anthropic/claude-sonnet-5.5';
  const AUTHOR = 'openai/gpt-6-luna';
  const REVIEWER = 'anthropic/claude-haiku-5.5';
  /** Контекст авторов - 40 000 токенов: обычный раздел влезает, глава в 160 000 знаков - нет (Р4). */
  const AUTHOR_CONTEXT = 40_000;
  const AUTHORS = [AUTHOR, 'z-ai/glm-5.3', 'qwen/qwen3.7-plus'];
  const priced = (id: string) => ({
    id,
    name: id,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['structured_outputs'],
    ...(AUTHORS.includes(id) ? { context_length: AUTHOR_CONTEXT } : {}),
  });
  const MODELS = {
    data: [
      DOSSIER_MODEL,
      AUTHOR,
      'z-ai/glm-5.3',
      'qwen/qwen3.7-plus',
      'openai/gpt-5.6-terra',
      REVIEWER,
      'deepseek/deepseek-v4-pro',
    ].map(priced),
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
  /** План: три раздела по главе. */
  const PLAN = [1, 2, 3].map((n) => ({ number: n, title: `Plan ${n}`, chapters: [n], why: 'x' }));
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
    chapters: [1, 2, 3].map((n) => ({ number: n, title: `C${n}`, summary: `Summary of ${n}.` })),
    summaryPlan: PLAN,
    voice: { pace: 'slow', sentenceLength: 'long', lexicon: 'plain', irony: 'none', devices: [] },
    motifs: [],
  };
  const OK_REVIEW = { verdict: 'ok', remarks: [] };
  /** Глоссарий `fr` запуска перевода: имя героини по глоссарию - Annette. */
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
  let answer: (name: string, body: ChatBody) => unknown;
  const calls: Array<{ name: string; body: ChatBody }> = [];
  const callsOf = (name: string) => calls.filter((c) => c.name === name);
  /** Номер главы читалки, по которой зовётся автор раздела. */
  const chapterOf = (body: ChatBody): number | null => {
    const m = /\[READER CHAPTER (\d+)\]/.exec(body.messages.map((x) => x.content).join('\n'));
    return m ? Number(m[1]) : null;
  };

  /** Первый текст автора - со служебной фразой (`JUNK`): ровно одна переделка, она чистая. */
  const junkFirst = (body: ChatBody, text: string) =>
    body.messages.some((m) => m.content.includes('PREVIOUS_TEXT'))
      ? { text }
      : { text: `Here is the summary. ${text}` };
  const defaultAnswer = (name: string, body: ChatBody): unknown =>
    ({
      dossier_part: PART,
      dossier: DOSSIER,
      summary_section_write: junkFirst(
        body,
        `Anna lives chapter ${chapterOf(body) ?? 0}.\n\nShe stays.`,
      ),
      summary_full_write: junkFirst(body, 'Anna lives the whole book.\n\nShe stays to the end.'),
      summary_brief_write: junkFirst(body, 'Anna lives.\n\nShe stays.'),
      summary_review: OK_REVIEW,
    })[name];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);

  const CHAPTERS = [1, 2, 3].map((n) => ({
    number: n,
    title: n === 1 ? 'The Road' : '',
    content: `<p>Anna in chapter ${n}.</p>`,
  }));

  /** Исходник на английском с тремя главами и готовым досье. */
  const sourceWithDossier = async (
    options: { chapters?: typeof CHAPTERS; status?: 'draft' | 'published' } = {},
  ) => {
    const slug = `f062-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.en,
        title: 'Book en',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: 'draft',
        originalLanguage: 'English',
        chapters: { create: options.chapters ?? CHAPTERS },
      },
    });
    if ((options.chapters ?? CHAPTERS).some((c) => c.content !== '')) {
      await auth(http().post(`/admin/versions/${version.id}/dossier`))
        .send({})
        .expect(202);
      await drain();
    }
    if (options.status === 'published') {
      await prisma.bookVersion.update({ where: { id: version.id }, data: { status: 'published' } });
    }
    calls.length = 0;
    return version.id;
  };

  /**
   * Исходник `en` с готовым досье и переведённая версия `fr`, сделанная запуском перевода
   * со статусом языка `languageStatus` (Р18); досье и глоссарий запуска - готовые.
   */
  const translatedBook = async (
    languageStatus: 'done' | 'running',
    operationStatus: 'done' | 'active',
  ) => {
    const slug = `f062-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const versionOf = (language: Language) =>
      prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language,
          title: `Book ${language}`,
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'draft',
          originalLanguage: 'English',
          chapters: { create: CHAPTERS },
        },
      });
    const source = (await versionOf(Language.en)).id;
    const translated = (await versionOf(Language.fr)).id;
    const dossier = await buildDossier(source);
    const glossary = await prisma.bookGlossary.create({
      data: { dossierId: dossier.id, language: 'fr', status: 'ready', data: GLOSSARY },
    });
    const op = await prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: 1, status: operationStatus },
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
              status: languageStatus,
              bookVersionId: translated,
            },
          ],
        },
      },
    });
    calls.length = 0;
    return { source, translated, dossier, glossary, run };
  };

  /** Готовое досье исходника - через кнопку и исполнителя, как в админке. */
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

  const drain = async () => {
    for (let i = 0; i < 120; i++) {
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

  const base = (versionId: string) => `/admin/versions/${versionId}/drafts/summary_write`;
  const start = (versionId: string) => auth(http().post(base(versionId))).send({});

  interface Item {
    index: number;
    target: string;
    number: number | null;
    title: string | null;
    readerChapter: number | null;
    html: string;
    attempt: number;
    verdict: string;
    remarks: Array<{ code: string; by: string }>;
    review: { kind: string; model: string | null } | null;
    outcome: string;
    failedReason: string | null;
    authorModel: string | null;
    regenerating: boolean;
  }
  interface Run {
    id: string;
    status: string;
    plannedSections: number | null;
    sectionsDone: number;
    owns: Record<string, boolean>;
    items: Item[];
    chapterChanges: number[];
    operation: { id: string; status: string; pauseReason: string | null };
  }
  const runOf = async (versionId: string): Promise<Run> => {
    const res = await auth(http().get(base(versionId))).expect(200);
    const run = (res.body as { draft: Run | null }).draft;
    if (!run) throw new Error(`no run of ${versionId}`);
    return run;
  };
  const itemOf = (run: Run, target: string, number: number | null = null): Item => {
    const item = run.items.find((i) => i.target === target && i.number === number);
    if (!item) throw new Error(`no ${target} ${number}`);
    return item;
  };
  const sectionsOf = (versionId: string) =>
    prisma.bookSummarySection.findMany({
      where: { bookVersionId: versionId },
      orderBy: { number: 'asc' },
    });
  const summaryOf = (versionId: string) =>
    prisma.bookSummary.findUnique({ where: { bookVersionId: versionId } });
  const itemPath = (run: Run, item: Item, action: string) =>
    `/admin/content-drafts/${run.id}/items/${item.index}/${action}`;

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
    const emails = {
      admin: `f062-admin-${stamp}@test.com`,
      cm: `f062-cm-${stamp}@test.com`,
      user: `f062-user-${stamp}@test.com`,
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
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    answer = (name, body) => defaultAnswer(name, body);
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

  it('access: admin only on every endpoint of the run; no token - 401', async () => {
    const versionId = await sourceWithDossier();
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path] of [
      ['get', `${base(versionId)}/estimate`],
      ['get', base(versionId)],
      ['post', base(versionId)],
      ['post', `/admin/content-drafts/${id}/items/0/regenerate`],
      ['post', `/admin/content-drafts/${id}/items/0/accept`],
      ['post', `/admin/content-drafts/${id}/items/0/discard`],
      ['post', `/admin/content-drafts/${id}/accept-all`],
      ['post', `/admin/content-drafts/${id}/discard-run`],
    ] as Array<['get' | 'post', string]>) {
      await http()[method](path).expect(401);
      await auth(http()[method](path), 'cm').expect(403);
      await auth(http()[method](path), 'user').expect(403);
    }
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('an empty unpublished version: every section of the plan, the full and the very short summary are written; one redo per text; the reviewer is of another family', async () => {
    const versionId = await sourceWithDossier();
    const estimate = await auth(http().get(`${base(versionId)}/estimate`)).expect(200);
    expect(estimate.body).toMatchObject({ sections: 3, upperBound: false, dossier: null });
    const started = await start(versionId).expect(202);
    expect(started.body).toMatchObject({
      status: 'building',
      owns: { sections: true, full: true, brief: true },
    });
    await drain();

    const run = await runOf(versionId);
    expect(run).toMatchObject({ status: 'ready', plannedSections: 3, sectionsDone: 3 });
    expect(run.items.map((i) => [i.target, i.number, i.outcome])).toEqual([
      ['section', 1, 'written'],
      ['section', 2, 'written'],
      ['section', 3, 'written'],
      ['full', null, 'written'],
      ['brief', null, 'written'],
    ]);
    const sections = await sectionsOf(versionId);
    // Номера - по плану, названия - по главам версии (§2.1): без названия - «Chapter N».
    expect(sections.map((s) => [s.number, s.title, s.readerChapter])).toEqual([
      [1, 'The Road', 1],
      [2, 'Chapter 2', 2],
      [3, 'Chapter 3', 3],
    ]);
    expect(sections[1].text).toBe('<p>Anna lives chapter 2.</p><p>She stays.</p>');
    const summary = await summaryOf(versionId);
    expect(summary).toMatchObject({ hasText: true, briefHasText: true });
    expect(summary?.summary).toBe('<p>Anna lives the whole book.</p><p>She stays to the end.</p>');
    // Служебная фраза - замечание кода: ровно одна переделка (U5), итог переделки в поле.
    expect(callsOf('summary_section_write')).toHaveLength(6);
    expect(callsOf('summary_full_write')).toHaveLength(2);
    expect(callsOf('summary_brief_write')).toHaveLength(2);
    const section = itemOf(run, 'section', 1);
    expect(section).toMatchObject({ attempt: 2, authorModel: AUTHOR });
    expect(section.remarks.map((r) => r.code)).not.toContain('JUNK');
    expect(sections[0].text).not.toContain('Here is the summary');
    // Переделка несёт прошлый текст и замечание кода.
    const redo = callsOf('summary_section_write')[1].body.messages[1].content;
    expect(redo).toContain('Here is the summary');
    expect(redo).toContain('JUNK');
    expect(section.review).toEqual({ kind: 'answered', model: REVIEWER });
    expect(callsOf('summary_review').every((c) => c.body.model !== AUTHOR)).toBe(true);
    // Полный строится из текстов разделов, «Очень кратко» - из полного.
    const fullPrompt = callsOf('summary_full_write')[0].body.messages[1].content;
    expect(fullPrompt).toContain('Anna lives chapter 3.');
    expect(callsOf('summary_brief_write')[0].body.messages[1].content).toContain(
      'Anna lives the whole book.',
    );
    // Публикации ход не меняет (D5); флагов в публичном ответе пересказа нет (U6).
    expect((await prisma.bookVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe(
      'draft',
    );
  });

  it('remarks left after the one redo: the text still goes to the field with flags, the remarks and the reviewer are in the run answer (product §8 п.4-5)', async () => {
    const versionId = await sourceWithDossier();
    answer = (name, body) =>
      name === 'summary_review'
        ? {
            verdict: 'remarks',
            remarks: [
              { code: 'FACT_UNSUPPORTED', where: 'Anna lives', note: 'not in the chapter' },
            ],
          }
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const section = itemOf(run, 'section', 1);
    expect(section).toMatchObject({ attempt: 2, verdict: 'flags', outcome: 'written' });
    expect(section.remarks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'FACT_UNSUPPORTED', by: 'model' })]),
    );
    expect(section.review).toEqual({ kind: 'answered', model: REVIEWER });
    // Ровно одна переделка: после неё замечания - флаги, а не третий круг.
    expect(callsOf('summary_section_write').filter((c) => chapterOf(c.body) === 1)).toHaveLength(2);
    expect((await sectionsOf(versionId))[0].text).toBe(
      '<p>Anna lives chapter 1.</p><p>She stays.</p>',
    );
    // Флаги - только в ответе хода (админка), не в поле пересказа (U6).
    expect((await sectionsOf(versionId))[0].text).not.toContain('FACT_UNSUPPORTED');
  });

  it('the editor edits section 2 mid-run: section 2 is kept, section 3 becomes a proposal; full and brief are still written', async () => {
    const versionId = await sourceWithDossier();
    answer = async (name, body) => {
      if (name === 'summary_section_write' && chapterOf(body) === 3) {
        await prisma.bookSummarySection.update({
          where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
          data: { text: '<p>Edited by the editor.</p>' },
        });
      }
      return defaultAnswer(name, body);
    };
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'section', 3).outcome).toBe('proposed');
    const sections = await sectionsOf(versionId);
    expect(sections.map((s) => s.number)).toEqual([1, 2]);
    expect(sections[1].text).toBe('<p>Edited by the editor.</p>');
    expect(itemOf(run, 'full').outcome).toBe('written');
    // Полный - из правки редактора, а не из текста хода (§5).
    expect(callsOf('summary_full_write')[0].body.messages[1].content).toContain(
      'Edited by the editor.',
    );
    // «Accept» раздела 3 - в конец, номер 3.
    await auth(http().post(itemPath(run, itemOf(run, 'section', 3), 'accept')))
      .send({})
      .expect(200);
    expect((await sectionsOf(versionId)).map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it('a published version: every text is a proposal, the fields are untouched', async () => {
    const versionId = await sourceWithDossier({ status: 'published' });
    const started = await start(versionId).expect(202);
    expect(started.body.owns).toEqual({ sections: false, full: false, brief: false });
    await drain();
    const run = await runOf(versionId);
    expect(run.items.map((i) => i.outcome)).toEqual(Array(5).fill('proposed'));
    expect(await sectionsOf(versionId)).toHaveLength(0);
    expect(await summaryOf(versionId)).toBeNull();

    // «В конец» - строго под номером плана: раздел 3 раньше раздела 1 не принимается (В1).
    const early = await auth(http().post(itemPath(run, itemOf(run, 'section', 3), 'accept')))
      .send({})
      .expect(409);
    expect(early.body).toMatchObject({ code: 'SUMMARY_FIELD_CHANGED', expectedNumber: 1 });
    // «Очень кратко» без полного с текстом - не «поле изменили», а своя причина (круг 2).
    const briefFirst = await auth(http().post(itemPath(run, itemOf(run, 'brief'), 'accept')))
      .send({})
      .expect(409);
    expect(briefFirst.body.code).toBe('SUMMARY_FULL_UNFINISHED');
    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'accept')))
      .send({})
      .expect(200);
    // «Accept all» - остальные по одному: разделы по номеру, затем полный и «Очень кратко».
    const all = await auth(http().post(`/admin/content-drafts/${run.id}/accept-all`)).expect(200);
    expect((all.body.items as Item[]).map((i) => i.outcome)).toEqual(Array(5).fill('accepted'));
    expect((await sectionsOf(versionId)).map((x) => [x.number, x.title])).toEqual([
      [1, 'The Road'],
      [2, 'Chapter 2'],
      [3, 'Chapter 3'],
    ]);
    expect(await summaryOf(versionId)).toMatchObject({ hasText: true, briefHasText: true });
  });

  it('the very short of a run is built from the full of the run: with the editor full in the field both are proposals; Accept of the full, then of the very short - 200; after an editor change - 409 with the field', async () => {
    const versionId = await sourceWithDossier();
    await auth(http().put(`/versions/${versionId}/summary`))
      .send({ summary: '<p>Editor full.</p>' })
      .expect(200);
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    expect(itemOf(run, 'full').outcome).toBe('proposed');
    // «Очень кратко» - из полного хода, а не из полного редактора; в поле - только предложением,
    // раз полный хода в поле не лёг (решение арбитра `F06 | F06-2`, круг 2).
    const briefPrompt = callsOf('summary_brief_write')[0].body.messages[1].content;
    expect(briefPrompt).toContain('Anna lives the whole book.');
    expect(briefPrompt).not.toContain('Editor full.');
    expect(itemOf(run, 'brief').outcome).toBe('proposed');
    expect(await summaryOf(versionId)).toMatchObject({ briefHasText: false });
    await auth(http().post(itemPath(run, itemOf(run, 'full'), 'accept')))
      .send({})
      .expect(200);
    await auth(http().post(itemPath(run, itemOf(run, 'brief'), 'accept')))
      .send({})
      .expect(200);
    expect(await summaryOf(versionId)).toMatchObject({
      summary: '<p>Anna lives the whole book.</p><p>She stays to the end.</p>',
      briefHasText: true,
    });
    run = await runOf(versionId);
    expect(itemOf(run, 'full').outcome).toBe('accepted');

    // Второй ход: полный теперь предложение; редактор правит полный - «Accept» 409.
    await start(versionId).expect(202);
    await drain();
    run = await runOf(versionId);
    await auth(http().put(`/versions/${versionId}/summary`))
      .send({ summary: '<p>Editor again.</p>' })
      .expect(200);
    const res = await auth(http().post(itemPath(run, itemOf(run, 'full'), 'accept')))
      .send({})
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'SUMMARY_FIELD_CHANGED',
      current: { text: '<p>Editor again.</p>' },
    });
    expect((await summaryOf(versionId))?.summary).toBe('<p>Editor again.</p>');
  });

  it('the full written by the run, the very short filled by the editor: the very short is a proposal and Accept of it is 200, not 409', async () => {
    const versionId = await sourceWithDossier();
    await prisma.bookSummary.create({
      data: {
        bookVersionId: versionId,
        summary: '',
        hasText: false,
        brief: '<p>Editor brief.</p>',
        briefHasText: true,
      },
    });
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'full').outcome).toBe('written');
    expect(itemOf(run, 'brief').outcome).toBe('proposed');
    await auth(http().post(itemPath(run, itemOf(run, 'brief'), 'accept')))
      .send({})
      .expect(200);
    expect((await summaryOf(versionId))?.brief).toBe('<p>Anna lives.</p><p>She stays.</p>');
  });

  it('a model text without visible text or past the field limit is not written: failed with the reason; a plan with a gap gives each section its own plan entry', async () => {
    answer = (name, body) => {
      if (name === 'dossier') {
        return {
          ...DOSSIER,
          summaryPlan: [
            { number: 1, title: 'P1', chapters: [1], why: 'why-one' },
            { number: 5, title: 'P2', chapters: [2], why: 'why-two' },
            { number: 9, title: 'P3', chapters: [3], why: 'why-three' },
          ],
        };
      }
      if (name === 'summary_section_write' && chapterOf(body) === 1) return { text: '   ' };
      if (name === 'summary_section_write' && chapterOf(body) === 2) {
        return { text: `${'Anna walks on. '.repeat(8_000)}` };
      }
      return defaultAnswer(name, body);
    };
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'section', 1)).toMatchObject({
      verdict: 'failed',
      failedReason: 'DRAFT_INVALID_RESPONSE',
    });
    expect(itemOf(run, 'section', 2)).toMatchObject({
      verdict: 'failed',
      failedReason: 'DRAFT_TOO_LONG',
    });
    expect(await sectionsOf(versionId)).toHaveLength(0);
    // План раздела 3 - третья запись плана (позиция), а не запись модели с номером 3.
    const third = callsOf('summary_section_write').find((c) => chapterOf(c.body) === 3);
    expect(third?.body.messages[1].content).toContain('why-three');
    expect(third?.body.messages[1].content).not.toContain('why-two');
  });

  it('final refusals: an empty plan - failed DRAFT_NO_PLAN; a section without chapter text - failed DRAFT_INPUT_MISSING without a call', async () => {
    answer = (name, body) =>
      name === 'dossier' ? { ...DOSSIER, summaryPlan: [] } : defaultAnswer(name, body);
    const noPlan = await sourceWithDossier();
    await start(noPlan).expect(202);
    await drain();
    expect(
      await prisma.contentDraft.findFirstOrThrow({
        where: { bookVersionId: noPlan, kind: 'summary_write' },
      }),
    ).toMatchObject({
      status: 'failed',
      failedReason: 'DRAFT_NO_PLAN',
    });

    answer = (name, body) => defaultAnswer(name, body);
    const versionId = await sourceWithDossier({
      chapters: CHAPTERS.map((c) => (c.number === 2 ? { ...c, content: '<p></p>' } : c)),
    });
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'section', 2)).toMatchObject({
      verdict: 'failed',
      failedReason: 'DRAFT_INPUT_MISSING',
    });
    expect(callsOf('summary_section_write').some((c) => chapterOf(c.body) === 2)).toBe(false);
  });

  it('Accept of a section on a version with sections: the same number is replaced, numbering kept, beyond the last - added at the end; another coverage of chapters needs a confirmation; Accept all - 409', async () => {
    const versionId = await sourceWithDossier();
    for (const [number, readerChapter] of [
      [1, 1],
      [2, 3],
    ]) {
      await prisma.bookSummarySection.create({
        data: {
          bookVersionId: versionId,
          number,
          title: `Old ${number}`,
          text: '<p>Old.</p>',
          readerChapter,
        },
      });
    }
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.items.filter((i) => i.target === 'section').map((i) => i.outcome)).toEqual([
      'proposed',
      'proposed',
      'proposed',
    ]);
    // Охват раздела 1 - главы 1-2 (до главы раздела 2), предложение - глава 1; раздела 2 - глава 3,
    // предложение - глава 2: оба - иное деление (В3).
    expect(run.chapterChanges).toEqual([1, 2]);
    const all = await auth(http().post(`/admin/content-drafts/${run.id}/accept-all`)).expect(409);
    expect(all.body.code).toBe('ACCEPT_ALL_CHAPTER_CHANGE');
    expect((await sectionsOf(versionId)).map((s) => s.title)).toEqual(['Old 1', 'Old 2']);

    const first = await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'accept')))
      .send({})
      .expect(409);
    expect(first.body).toMatchObject({
      code: 'SUMMARY_CHAPTER_CHANGE',
      covers: { from: 1, to: 2 },
      willCover: { from: 1, to: 1 },
      sameChapterSections: [],
    });
    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'accept')))
      .send({ confirmChapterChange: true })
      .expect(200);
    const change = await auth(http().post(itemPath(run, itemOf(run, 'section', 2), 'accept')))
      .send({})
      .expect(409);
    // Раздел 1 после замены охватывает главы 1-2: он покроет и главу 2 нового раздела 2.
    expect(change.body).toMatchObject({
      code: 'SUMMARY_CHAPTER_CHANGE',
      covers: { from: 3, to: 3 },
      willCover: { from: 2, to: 2 },
      sameChapterSections: [1],
    });
    await auth(http().post(itemPath(run, itemOf(run, 'section', 2), 'accept')))
      .send({ confirmChapterChange: true })
      .expect(200);
    await auth(http().post(itemPath(run, itemOf(run, 'section', 3), 'accept')))
      .send({})
      .expect(200);
    const sections = await sectionsOf(versionId);
    expect(sections.map((s) => [s.number, s.title, s.readerChapter])).toEqual([
      [1, 'The Road', 1],
      [2, 'Chapter 2', 2],
      [3, 'Chapter 3', 3],
    ]);
    // Повторный «Accept» принятого - 409, поле не меняется.
    const again = await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'accept')))
      .send({})
      .expect(409);
    expect(again.body.code).toBe('SUMMARY_ITEM_NOT_PROPOSED');
  });

  it('a section that failed: later sections wait, the full is not built; Regenerate of the section writes it, the waiting sections, the full and the very short', async () => {
    const versionId = await sourceWithDossier();
    // Ответ не по форме у раздела 2 - и у запасных моделей: «не удалось».
    answer = (name, body) =>
      name === 'summary_section_write' && chapterOf(body) === 2
        ? { wrong: true }
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.items.map((i) => [i.target, i.number, i.outcome, i.verdict])).toEqual([
      ['section', 1, 'written', 'ok'],
      ['section', 2, 'none', 'failed'],
      ['section', 3, 'waiting', 'ok'],
    ]);
    expect(itemOf(run, 'section', 2).failedReason).toBe('DRAFT_INVALID_RESPONSE');
    // «Не удалось» в счёт готовых разделов не идёт (круг 3).
    expect(run.sectionsDone).toBe(2);
    expect((await sectionsOf(versionId)).map((s) => s.number)).toEqual([1]);
    expect(callsOf('summary_full_write')).toHaveLength(0);
    answer = (name, body) => defaultAnswer(name, body);
    calls.length = 0;
    run = await runOf(versionId);
    await auth(http().post(itemPath(run, itemOf(run, 'section', 2), 'regenerate')))
      .send({ remark: 'Mention the bridge.' })
      .expect(202);
    // Вторая перегенерация того же текста до конца первой - 409.
    const twice = await auth(http().post(itemPath(run, itemOf(run, 'section', 2), 'regenerate')))
      .send({})
      .expect(409);
    expect(twice.body.code).toBe('SUMMARY_REGEN_IN_PROGRESS');
    await drain();

    // Замечание редактора - в промпте автора.
    expect(callsOf('summary_section_write')[0].body.messages[1].content).toContain(
      'Mention the bridge.',
    );
    run = await runOf(versionId);
    expect(run.items.map((i) => [i.target, i.number, i.outcome])).toEqual([
      ['section', 1, 'written'],
      ['section', 2, 'written'],
      ['section', 3, 'written'],
      ['full', null, 'written'],
      ['brief', null, 'written'],
    ]);
    expect(itemOf(run, 'section', 2).regenerating).toBe(false);
    expect((await sectionsOf(versionId)).map((s) => s.number)).toEqual([1, 2, 3]);
    expect(await summaryOf(versionId)).toMatchObject({ hasText: true, briefHasText: true });
  });

  it('Regenerate of a filled field written by someone else is a proposal; Discard of it keeps the field', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    await auth(http().put(`/versions/${versionId}/summary`))
      .send({ summary: '<p>Editor full.</p>' })
      .expect(200);
    await auth(http().post(itemPath(run, itemOf(run, 'full'), 'regenerate')))
      .send({})
      .expect(202);
    // «Discard» текста, перегенерация которого идёт, - 409: её итог вернул бы предложение (круг 2).
    const busy = await auth(http().post(itemPath(run, itemOf(run, 'full'), 'discard'))).expect(409);
    expect(busy.body.code).toBe('SUMMARY_REGEN_IN_PROGRESS');
    await drain();
    run = await runOf(versionId);
    expect(itemOf(run, 'full').outcome).toBe('proposed');
    await auth(http().post(itemPath(run, itemOf(run, 'full'), 'discard'))).expect(200);
    run = await runOf(versionId);
    expect(itemOf(run, 'full').outcome).toBe('discarded');
    expect((await summaryOf(versionId))?.summary).toBe('<p>Editor full.</p>');
  });

  it('pause by the ceiling mid-run, Continue finishes the run without paying again for written texts', async () => {
    const versionId = await sourceWithDossier();
    let paused = false;
    answer = async (name, body) => {
      // После оплаченного раздела 2 потолок исчерпан: следующий вызов - пауза операции.
      if (!paused && name === 'summary_review' && chapterOf(body) === 2) {
        paused = true;
        await prisma.llmBudget.update({
          where: { id: LLM_BUDGET_ID },
          data: { ceilingUsd: 0.00001 },
        });
      }
      return defaultAnswer(name, body);
    };
    const started = await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    expect(run.status).toBe('building');
    expect(run.operation.status).toBe('paused');
    const before = calls.length;
    await resetBudget();
    await auth(http().post(`/admin/llm/operations/${started.body.operation.id as string}/resume`))
      .send({})
      .expect(200);
    await drain();
    run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.items).toHaveLength(5);
    // Раздел 1 и оплаченный текст раздела 2 второй раз не оплачиваются (Р3).
    const after = calls.slice(before).filter((c) => c.name === 'summary_section_write');
    expect(after.some((c) => chapterOf(c.body) === 1)).toBe(false);
    // Пауза - на переделке раздела 2: после «Continue» ровно один вызов автора (переделка), не два.
    expect(after.filter((c) => chapterOf(c.body) === 2).length).toBe(1);
    expect((await sectionsOf(versionId)).map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it('a text that does not fit the input - failed DRAFT_TOO_LONG before any call (Р4)', async () => {
    const huge = `<p>${'word '.repeat(32_000)}</p>`;
    const versionId = await sourceWithDossier({
      chapters: CHAPTERS.map((c) => (c.number === 1 ? { ...c, content: huge } : c)),
    });
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'section', 1)).toMatchObject({
      verdict: 'failed',
      failedReason: 'DRAFT_TOO_LONG',
    });
    expect(callsOf('summary_section_write').every((c) => chapterOf(c.body) !== 1)).toBe(true);
    // Полный без текста раздела 1 не строится (`product.md` §3).
    expect(callsOf('summary_full_write')).toHaveLength(0);
  }, 120_000);

  it('source edited after the dossier - 409 DOSSIER_STALE on estimate and start, no run; a version without chapter text - 409 SOURCE_HAS_NO_CHAPTERS', async () => {
    const versionId = await sourceWithDossier();
    await prisma.chapter.updateMany({
      where: { bookVersionId: versionId, number: 1 },
      data: { content: '<p>Anna in chapter 1, edited.</p>' },
    });
    expect((await auth(http().get(`${base(versionId)}/estimate`)).expect(409)).body.code).toBe(
      'DOSSIER_STALE',
    );
    expect((await start(versionId).expect(409)).body.code).toBe('DOSSIER_STALE');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);

    const empty = await sourceWithDossier({
      chapters: CHAPTERS.map((c) => ({ ...c, content: '' })),
    });
    expect((await start(empty).expect(409)).body.code).toBe('SOURCE_HAS_NO_CHAPTERS');
  });

  it('a translated version: the dossier and glossary of its run, no freshness check, names by the run glossary (Р18, F06-3 А5)', async () => {
    const { source, translated, dossier, glossary } = await translatedBook('done', 'done');
    // Исходник правлен после досье запуска: переведённой версии это не мешает (нет DOSSIER_STALE).
    await prisma.chapter.updateMany({
      where: { bookVersionId: source, number: 1 },
      data: { content: '<p>Edited source.</p>' },
    });
    // У исходника уже новое поколение досье, без глоссария `fr`: переведённая версия его не берёт.
    const fresh = await buildDossier(source);
    expect(fresh.id).not.toBe(dossier.id);
    const dossiersBefore = await prisma.bookDossier.count({ where: { sourceVersionId: source } });
    calls.length = 0;

    const estimate = await auth(http().get(`${base(translated)}/estimate`)).expect(200);
    expect(estimate.body).toMatchObject({
      dossier: null,
      glossary: null,
      sections: 3,
      upperBound: false,
    });
    const started = await start(translated).expect(202);
    expect(started.body.language).toBe('fr');
    await drain();

    const row = await prisma.contentDraft.findFirstOrThrow({
      where: { bookVersionId: translated, kind: 'summary_write' },
    });
    expect(row).toMatchObject({ status: 'ready', dossierId: dossier.id, glossaryId: glossary.id });
    const first = callsOf('summary_section_write')[0].body;
    expect(first.messages[1].content).toContain('Annette');
    expect(first.messages[0].content).toContain('French');
    // Ни досье, ни глоссарий ход не строил.
    expect(callsOf('dossier')).toHaveLength(0);
    expect(callsOf('glossary')).toHaveLength(0);
    expect(await prisma.bookDossier.count({ where: { sourceVersionId: source } })).toBe(
      dossiersBefore,
    );
    expect(await prisma.bookGlossary.count({ where: { dossierId: dossier.id } })).toBe(1);
    expect(await prisma.bookGlossary.count({ where: { dossierId: fresh.id } })).toBe(0);
  });

  it('a translated version: its run still writing - 409 RUN_LANGUAGE_UNFINISHED; a failed run - the run dossier (Р18); the run dossier gone - 409 DRAFT_DOSSIER_MISSING; no run row on a refusal (F06-3 А5)', async () => {
    const { translated, dossier, glossary, run } = await translatedBook('running', 'active');
    const rows = () => prisma.contentDraft.count({ where: { bookVersionId: translated } });

    const unfinished = await auth(http().get(`${base(translated)}/estimate`)).expect(409);
    expect(unfinished.body.code).toBe('RUN_LANGUAGE_UNFINISHED');
    expect((await start(translated).expect(409)).body.code).toBe('RUN_LANGUAGE_UNFINISHED');
    expect(await rows()).toBe(0);

    await prisma.translationRunLanguage.updateMany({
      where: { runId: run.id },
      data: { status: 'failed' },
    });
    const started = await start(translated).expect(202);
    const row = await prisma.contentDraft.findUniqueOrThrow({
      where: { id: started.body.id as string },
    });
    expect(row).toMatchObject({
      kind: 'summary_write',
      dossierId: dossier.id,
      glossaryId: glossary.id,
    });
    await auth(http().post(`/admin/content-drafts/${row.id}/discard-run`)).expect(200);

    await prisma.translationRun.update({ where: { id: run.id }, data: { dossierId: null } });
    const gone = await auth(http().get(`${base(translated)}/estimate`)).expect(409);
    expect(gone.body.code).toBe('DRAFT_DOSSIER_MISSING');
    expect((await start(translated).expect(409)).body.code).toBe('DRAFT_DOSSIER_MISSING');
    expect(await rows()).toBe(1);
    expect(
      await prisma.contentDraft.count({
        where: { bookVersionId: translated, status: { not: 'discarded' } },
      }),
    ).toBe(0);
    expect(callsOf('summary_section_write')).toHaveLength(0);
  });

  it('repeat start while building - 409 DRAFT_IN_PROGRESS; Discard of a building run cancels its operation; Discard of a ready run cancels its regenerations', async () => {
    const versionId = await sourceWithDossier();
    const first = await start(versionId).expect(202);
    expect((await start(versionId).expect(409)).body.code).toBe('DRAFT_IN_PROGRESS');
    const discarded = await auth(
      http().post(`/admin/content-drafts/${first.body.id as string}/discard-run`),
    ).expect(200);
    expect(discarded.body).toMatchObject({
      status: 'discarded',
      operation: { status: 'cancelled' },
    });
    await drain();
    expect(await sectionsOf(versionId)).toHaveLength(0);

    // Отмена посреди вызова модели: оплаченный ответ после «Discard» ход не воскрешает и в поле не пишется.
    const second = await start(versionId).expect(202);
    // Текст без служебной фразы - без переделки: после ответа проверяющей вызовов больше нет,
    // и запись держит только условие строки (статус и операция хода).
    let discardedOnce = false;
    answer = async (name, body) => {
      if (name === 'summary_section_write') return { text: 'Anna lives in the town.' };
      if (name === 'summary_review' && !discardedOnce) {
        discardedOnce = true;
        await auth(
          http().post(`/admin/content-drafts/${second.body.id as string}/discard-run`),
        ).expect(200);
      }
      return defaultAnswer(name, body);
    };
    await drain();
    answer = (name, body) => defaultAnswer(name, body);
    expect(await sectionsOf(versionId)).toHaveLength(0);
    const gone = await prisma.contentDraft.findUniqueOrThrow({
      where: { id: second.body.id as string },
    });
    expect(gone.status).toBe('discarded');

    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'regenerate')))
      .send({})
      .expect(202);
    const regenItem = (await runOf(versionId)).items[0] as Item & { regenOperationId: string };
    expect(regenItem.regenerating).toBe(true);
    // F06-5c: статус и причина паузы перегенерации - из её операции, по строке в базе.
    expect(regenItem).toMatchObject({ regenOperationStatus: 'active', regenPauseReason: null });
    await prisma.llmOperation.update({
      where: { id: regenItem.regenOperationId },
      data: { status: 'paused', pauseReason: 'LIMIT_REACHED' },
    });
    expect((await runOf(versionId)).items[0]).toMatchObject({
      regenerating: true,
      regenOperationStatus: 'paused',
      regenPauseReason: 'LIMIT_REACHED',
    });
    expect(itemOf(await runOf(versionId), 'full')).toMatchObject({
      regenOperationStatus: null,
      regenPauseReason: null,
    });
    await prisma.llmOperation.update({
      where: { id: regenItem.regenOperationId },
      data: { status: 'active', pauseReason: null },
    });
    await auth(http().post(`/admin/content-drafts/${run.id}/discard-run`)).expect(200);
    // Операция перегенерации отменена - по её строке в базе, а не по ответу ручки (L-017).
    const regenOp = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: regenItem.regenOperationId },
    });
    expect(regenOp.status).toBe('cancelled');
    await drain();
    expect(await auth(http().get(base(versionId))).expect(200)).toHaveProperty('body.draft', null);
  });

  it('the run row stops taking the step while the author writes (its operation still active): no reviewer and no redo is paid after it (круг 3)', async () => {
    const versionId = await sourceWithDossier();
    const started = await start(versionId).expect(202);
    let discarded = false;
    answer = async (name, body) => {
      if (name === 'summary_section_write' && !discarded) {
        discarded = true;
        // Строка ушла в `discarded`, операция ещё `active` (окно между коммитом нового старта и
        // отменой перегенераций прежнего): условие строки - последний рубеж до оплаты.
        await prisma.contentDraft.update({
          where: { id: started.body.id as string },
          data: { status: 'discarded' },
        });
      }
      return defaultAnswer(name, body);
    };
    await drain();
    expect(callsOf('summary_section_write')).toHaveLength(1);
    expect(callsOf('summary_review')).toHaveLength(0);
    expect(await sectionsOf(versionId)).toHaveLength(0);
    // Операция закрыта, а не висит `active` без задач (круг 4).
    const op = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: started.body.operation.id as string },
    });
    expect(op.status).toBe('done');
  });

  it('the run routes refuse a draft row of another kind: 404, the draft and its operation untouched (круг 4)', async () => {
    const versionId = await sourceWithDossier();
    const op = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'active' },
    });
    const draft = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind: 'analysis',
        status: 'ready',
        language: 'en',
        operationId: op.id,
        data: { analysis: { language: 'en' } },
      },
    });
    for (const path of [
      'discard-run',
      'accept-all',
      'items/0/accept',
      'items/0/discard',
      'items/0/regenerate',
    ]) {
      await auth(http().post(`/admin/content-drafts/${draft.id}/${path}`))
        .send({})
        .expect(404);
    }
    expect((await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'ready',
    );
    expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      'active',
    );
  });

  it('cancel of a regeneration from the operations page: the mark is cleared, the run stays ready; Continue of a paused regeneration finishes it', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'regenerate')))
      .send({})
      .expect(202);
    let op = await prisma.llmOperation.findFirstOrThrow({
      where: { bookVersionId: versionId, kind: 'draft', status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    await auth(http().post(`/admin/llm/operations/${op.id}/cancel`)).expect(200);
    run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(itemOf(run, 'section', 1).regenerating).toBe(false);

    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'regenerate')))
      .send({})
      .expect(202);
    op = await prisma.llmOperation.findFirstOrThrow({
      where: { bookVersionId: versionId, kind: 'draft', status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      'paused',
    );
    await resetBudget();
    await auth(http().post(`/admin/llm/operations/${op.id}/resume`))
      .send({})
      .expect(200);
    await drain();
    run = await runOf(versionId);
    // Текст, записанный ходом, перегенерация меняет только предложением; поле не изменилось (В2).
    const before = (await sectionsOf(versionId))[0].text;
    expect(itemOf(run, 'section', 1)).toMatchObject({ regenerating: false, outcome: 'proposed' });
    expect((await sectionsOf(versionId))[0].text).toBe(before);
    expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      'done',
    );
  });

  it('a regeneration without a text keeps the previous text with the reason; the tail after a section is tried once', async () => {
    const versionId = await sourceWithDossier();
    // Раздел 2 не удаётся: полного нет. Перегенерация раздела 2 удаётся, полный - нет: достройка
    // пробует его один раз и кончается, без повтора по кругу.
    answer = (name, body) =>
      (name === 'summary_section_write' && chapterOf(body) === 2) || name === 'summary_full_write'
        ? { wrong: true }
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    answer = (name, body) =>
      name === 'summary_full_write' ? { wrong: true } : defaultAnswer(name, body);
    await auth(http().post(itemPath(run, itemOf(run, 'section', 2), 'regenerate')))
      .send({})
      .expect(202);
    await drain();
    run = await runOf(versionId);
    expect(itemOf(run, 'section', 2)).toMatchObject({ outcome: 'written', regenerating: false });
    expect(itemOf(run, 'full')).toMatchObject({ verdict: 'failed', outcome: 'none' });
    expect(run.items.some((i) => i.target === 'brief')).toBe(false);
    const fullCalls = callsOf('summary_full_write').length;
    expect(fullCalls).toBeGreaterThan(0);
    expect(fullCalls).toBeLessThanOrEqual(8);

    // Перегенерация раздела 1 без ответа по форме: прежний текст остаётся, причина видна.
    answer = (name, body) =>
      name === 'summary_section_write' ? { wrong: true } : defaultAnswer(name, body);
    const textBefore = itemOf(run, 'section', 1).html;
    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'regenerate')))
      .send({})
      .expect(202);
    await drain();
    run = await runOf(versionId);
    expect(itemOf(run, 'section', 1)).toMatchObject({
      html: textBefore,
      outcome: 'written',
      regenFailedReason: 'DRAFT_INVALID_RESPONSE',
      regenerating: false,
    });
  });

  it('Accept of a waiting section after the editor wrote the section before it by hand: proposed «at the end» and accepted under its plan number', async () => {
    const versionId = await sourceWithDossier();
    answer = (name, body) =>
      name === 'summary_section_write' && chapterOf(body) === 2
        ? { wrong: true }
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    expect(itemOf(run, 'section', 3).outcome).toBe('waiting');
    await prisma.bookSummarySection.create({
      data: {
        bookVersionId: versionId,
        number: 2,
        title: 'Mine',
        text: '<p>Mine.</p>',
        readerChapter: 2,
      },
    });
    await auth(http().post(itemPath(run, itemOf(run, 'section', 3), 'accept')))
      .send({})
      .expect(200);
    run = await runOf(versionId);
    expect(itemOf(run, 'section', 3).outcome).toBe('accepted');
    expect((await sectionsOf(versionId)).map((x) => [x.number, x.title])).toEqual([
      [1, 'The Road'],
      [2, 'Mine'],
      [3, 'Chapter 3'],
    ]);
  });

  it('refusals of the item routes: a building run - 409 SUMMARY_WRITE_NOT_READY (also Accept all), an unknown index - 400, a remark over 2000 - 400', async () => {
    const versionId = await sourceWithDossier();
    const started = await start(versionId).expect(202);
    const id = started.body.id as string;
    for (const path of [`items/0/accept`, `items/0/regenerate`, `items/0/discard`, `accept-all`]) {
      const res = await auth(http().post(`/admin/content-drafts/${id}/${path}`))
        .send({})
        .expect(409);
      expect([path, res.body.code]).toEqual([path, 'SUMMARY_WRITE_NOT_READY']);
    }
    await drain();
    const unknown = await auth(http().post(`/admin/content-drafts/${id}/items/99/accept`))
      .send({})
      .expect(400);
    expect(unknown.body.code).toBe('SUMMARY_ITEM_UNKNOWN');
    await auth(http().post(`/admin/content-drafts/${id}/items/0/regenerate`))
      .send({ remark: 'x'.repeat(2001) })
      .expect(400);
  });

  it('a new start while a regeneration of the previous run is running: the previous run is discarded, its regeneration operation cancelled and its mark cleared (T191, LEGACY-498)', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    await auth(http().post(itemPath(run, itemOf(run, 'section', 1), 'regenerate')))
      .send({})
      .expect(202);
    const regenItem = (await runOf(versionId)).items[0] as Item & { regenOperationId: string };
    expect(regenItem.regenerating).toBe(true);
    // Ещё сотня прежних упавших ходов: чтение идёт второй порцией по курсору `id` на живой базе,
    // ход с отметкой - в случайном месте порядка uuid.
    const { language } = await prisma.contentDraft.findUniqueOrThrow({ where: { id: run.id } });
    for (let n = 0; n < 100; n++) {
      const op = await prisma.llmOperation.create({
        data: { kind: 'draft', limitUsd: 1, status: 'failed', bookVersionId: versionId },
      });
      await prisma.contentDraft.create({
        data: {
          bookVersionId: versionId,
          kind: 'summary_write',
          status: 'failed',
          language,
          operationId: op.id,
        },
      });
    }
    // Новый старт - без исполнения перегенерации: отметка ещё стоит на тексте прежнего хода.
    await start(versionId).expect(202);
    // По строкам в базе, а не по ответу ручки (L-017): чтение отметки идёт запросом jsonb.
    expect(
      (await prisma.llmOperation.findUniqueOrThrow({ where: { id: regenItem.regenOperationId } }))
        .status,
    ).toBe('cancelled');
    const old = await prisma.contentDraft.findUniqueOrThrow({ where: { id: run.id } });
    expect(old.status).toBe('discarded');
    expect(
      await prisma.contentDraft.count({
        where: {
          bookVersionId: versionId,
          kind: 'summary_write',
          status: { in: ['ready', 'failed'] },
        },
      }),
    ).toBe(0);
    const items = (old.data as { items: Array<{ regen: unknown }> }).items;
    expect(items[0].regen).toBeNull();
    await drain();
  });
});
