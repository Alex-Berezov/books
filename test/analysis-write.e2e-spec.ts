/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import {
  ContextEstimate,
  DossierDemandService,
} from '../src/modules/translation/dossier/dossier-demand.service';
import { quotePrint } from '../src/modules/translation/analysis-write/analysis-write.steps';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F07-1a: ход анализа «Write Analysis» - шаги 1-3 (карточка и герои, цитаты и приёмы, толкования)
 * циклом качества, запись блоков через импорт `F03` под условием, предложения, выброс цитат,
 * переделка по DTO импорта, ядро. Исполнитель на базе, проходы руками; внешний `fetch` подменён,
 * ответ модели - по имени схемы ответа.
 */
describe('Analysis run «Write Analysis» (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const DOSSIER_MODEL = 'anthropic/claude-sonnet-5.5';
  const AUTHOR = 'z-ai/glm-5.3';
  const REVIEWER = 'openai/gpt-6-luna';
  const priced = (id: string) => ({
    id,
    name: id,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['structured_outputs'],
    context_length: 400_000,
  });
  const MODELS = {
    data: [
      DOSSIER_MODEL,
      AUTHOR,
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
    summaryPlan: [{ number: 1, title: 'Plan', chapters: [1, 2, 3], why: 'x' }],
    voice: { pace: 'slow', sentenceLength: 'long', lexicon: 'plain', irony: 'none', devices: [] },
    motifs: [],
  };
  const GLOSSARY = {
    entries: [
      {
        key: 'anna',
        source: 'Anna',
        target: 'Anna',
        kind: 'character',
        keepOriginal: true,
        note: '',
      },
    ],
    address: [],
    phrases: [],
  };

  /** Строки глав - дословные цитаты ответов модели. */
  const LINES = {
    river: 'Anna walked along the cold river at dawn.',
    never: 'I will never come back to this town, said Anna.',
    bell: 'Boris rang the old bell three times over the square.',
    leave: 'At last Anna closed the door and left the town for good.',
  };
  const CHAPTERS = [
    { number: 1, title: 'The River', content: `<p>${LINES.river}</p><p>${LINES.never}</p>` },
    { number: 2, title: 'The Bell', content: `<p>${LINES.bell}</p>` },
    { number: 3, title: 'The Door', content: `<p>${LINES.leave}</p>` },
  ];

  const CAST = {
    facts: {
      settingPlace: 'A small river town',
      settingTime: 'The early twentieth century',
      narrator: 'Third person',
      structure: 'Three chapters',
    },
    characters: [
      {
        key: 'anna',
        name: 'Anna',
        role: 'main',
        description: 'Anna is a young woman who wants to leave the town of her childhood.',
        arcFrom: 'bound to the town',
        arcTo: 'free of it',
        quote: LINES.never,
        quoteChapter: 1,
        relations: [{ to: 'boris', label: 'brother' }],
      },
      {
        key: 'boris',
        name: 'Boris',
        role: 'secondary',
        description: 'Boris is her brother who stays and keeps ringing the old bell.',
        arcFrom: '',
        arcTo: '',
        quote: '',
        quoteChapter: 0,
        relations: [],
      },
    ],
  };
  const keyQuote = (text: string, chapter: number, speakerKey = 'anna') => ({
    text,
    chapter,
    speakerKey,
    interpretation: 'The line marks the moment when the heroine chooses to leave for good.',
  });
  const QUOTES = {
    keyQuotes: [
      keyQuote(LINES.never, 1),
      keyQuote(LINES.bell, 2, 'boris'),
      keyQuote(LINES.leave, 3),
    ],
    style: [
      {
        device: 'Repetition',
        explanation: 'The bell returns in every chapter and measures the time the heroine loses.',
        example: 'rang the old bell three times',
        exampleChapter: 2,
      },
    ],
  };
  const theme = (key: string, title: string) => ({
    key,
    title,
    interpretation: `The theme of ${title.toLowerCase()} grows from the river scene to the closed door.`,
    chapters: [1, 3],
    quotes: [{ text: LINES.river, chapter: 1, comment: 'The river opens the theme.' }],
  });
  const MEANING = {
    mainIdea: 'The book asks whether a person can leave home without losing herself.',
    themes: [theme('loss', 'Loss'), theme('home', 'Home')],
    symbols: [
      {
        title: 'The bell',
        interpretation: 'The bell stands for the town that holds Anna back.',
        chapters: [2],
        quote: LINES.bell,
        quoteChapter: 2,
      },
    ],
    titleMeaning: 'The title names the place the heroine cannot keep.',
    endingMeaning: 'The closed door shows that the choice is final.',
    themeLinks: {
      characters: [
        { key: 'anna', themeKeys: ['loss', 'home'] },
        { key: 'boris', themeKeys: ['home'] },
      ],
      keyQuotes: [
        { id: quotePrint(LINES.never), themeKeys: ['loss'] },
        { id: quotePrint(LINES.bell), themeKeys: ['home'] },
      ],
    },
  };
  const OK_REVIEW = { verdict: 'ok', remarks: [] };

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
  const textOf = (body: ChatBody) => body.messages.map((m) => m.content).join('\n');

  const defaultAnswer = (name: string): unknown =>
    ({
      dossier_part: PART,
      dossier: DOSSIER,
      analysis_cast_write: CAST,
      analysis_quotes_write: QUOTES,
      analysis_meaning_write: MEANING,
      analysis_review: OK_REVIEW,
    })[name];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);

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

  const versionData = (bookId: string, language: Language) => ({
    bookId,
    language,
    title: `Book ${language}`,
    author: 'Author',
    description: 'Desc',
    coverImageUrl: 'https://example.com/c.jpg',
    type: 'text' as const,
    isFree: true,
    status: 'draft' as const,
    originalLanguage: 'English',
    chapters: { create: CHAPTERS },
  });

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

  /** Исходник `en` с тремя главами и готовым досье. */
  const sourceWithDossier = async (options: { status?: 'published' } = {}) => {
    const slug = `f071-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const version = await prisma.bookVersion.create({ data: versionData(book.id, Language.en) });
    await buildDossier(version.id);
    if (options.status === 'published') {
      await prisma.bookVersion.update({ where: { id: version.id }, data: { status: 'published' } });
    }
    calls.length = 0;
    return version.id;
  };

  /** Исходник `en` с готовым досье и версия `fr`, сделанная законченным запуском перевода. */
  const translatedBook = async () => {
    const slug = `f071-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const source = (await prisma.bookVersion.create({ data: versionData(book.id, Language.en) }))
      .id;
    const translated = (
      await prisma.bookVersion.create({ data: versionData(book.id, Language.fr) })
    ).id;
    const dossier = await buildDossier(source);
    const glossary = await prisma.bookGlossary.create({
      data: { dossierId: dossier.id, language: 'fr', status: 'ready', data: GLOSSARY },
    });
    const op = await prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: 1, status: 'done' },
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
    calls.length = 0;
    return { bookId: book.id, source, translated };
  };

  const base = (versionId: string) => `/admin/versions/${versionId}/drafts/analysis_write`;
  const start = (versionId: string) => auth(http().post(base(versionId))).send({});

  interface Item {
    index: number;
    target: string;
    step: number;
    verdict: string;
    remarks: Array<{ code: string; where: string; by: string }>;
    outcome: string;
    failedReason: string | null;
    links: boolean;
  }
  interface Run {
    id: string;
    status: string;
    owns: string[];
    steps: Array<{
      step: number;
      verdict: string;
      remarks: Array<{ code: string; where: string }>;
      attempt: number;
      outcome: string;
      dropped: Array<{ code: string; path: string }>;
    }>;
    items: Item[];
    droppedQuotes: Array<{ step: number; path: string; text: string; reason: string }>;
  }
  const runOf = async (versionId: string): Promise<Run> => {
    const res = await auth(http().get(base(versionId))).expect(200);
    const run = (res.body as { draft: Run | null }).draft;
    if (!run) throw new Error(`no run of ${versionId}`);
    return run;
  };
  const outcomes = (run: Run) =>
    run.items.map((i) => [i.step, i.target, i.links ? 'links' : 'text', i.outcome]);
  const analysisOf = (versionId: string) =>
    prisma.bookAnalysis.findUnique({ where: { bookVersionId: versionId } });

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
      admin: `f071-admin-${stamp}@test.com`,
      cm: `f071-cm-${stamp}@test.com`,
      user: `f071-user-${stamp}@test.com`,
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

  it('access: admin only on the estimate, the run and the start; no token - 401', async () => {
    const versionId = await sourceWithDossier();
    for (const [method, path] of [
      ['get', `${base(versionId)}/estimate`],
      ['get', base(versionId)],
      ['post', base(versionId)],
    ] as Array<['get' | 'post', string]>) {
      await http()[method](path).expect(401);
      await auth(http()[method](path), 'cm').expect(403);
      await auth(http()[method](path), 'user').expect(403);
    }
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('an empty unpublished version: steps 1-3 write the analysis, the core is ready, themeKeys of step 3 are written into the blocks of steps 1-2 without proposals', async () => {
    const versionId = await sourceWithDossier();
    const estimate = await auth(http().get(`${base(versionId)}/estimate`)).expect(200);
    expect(estimate.body).toMatchObject({ dossier: null, glossary: null, upperBound: false });
    expect(Number(estimate.body.stageUsd)).toBeGreaterThan(0);
    const started = await start(versionId).expect(202);
    expect(started.body.status).toBe('building');
    expect(started.body.owns).toEqual(
      expect.arrayContaining(['characters', 'themes', 'facts.narrator']),
    );
    await drain();

    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.steps.map((s) => [s.step, s.outcome, s.verdict])).toEqual([
      [1, 'done', 'ok'],
      [2, 'done', 'ok'],
      [3, 'done', 'ok'],
    ]);
    expect(run.items.every((i) => i.outcome === 'written')).toBe(true);
    expect(outcomes(run).filter(([, , kind]) => kind === 'links')).toEqual([
      [3, 'characters', 'links', 'written'],
      [3, 'keyQuotes', 'links', 'written'],
    ]);
    const analysis = await analysisOf(versionId);
    expect(analysis?.hasCore).toBe(true);
    expect(analysis?.facts).toEqual(CAST.facts);
    expect(analysis?.mainIdea).toBe(MEANING.mainIdea);
    const characters = analysis?.characters as Array<{ key: string; themeKeys?: string[] }>;
    expect(characters.map((c) => [c.key, c.themeKeys])).toEqual([
      ['anna', ['loss', 'home']],
      ['boris', ['home']],
    ]);
    const quotes = analysis?.keyQuotes as Array<{ text: string; themeKeys?: string[] }>;
    expect(quotes.map((q) => q.themeKeys ?? [])).toEqual([['loss'], ['home'], []]);
    // Один проход на шаг: замечаний нет - переделки нет; проверяющая - другого семейства.
    expect(callsOf('analysis_cast_write')).toHaveLength(1);
    expect(callsOf('analysis_meaning_write')).toHaveLength(1);
    expect(callsOf('analysis_review').map((c) => c.body.model)).toEqual([
      REVIEWER,
      REVIEWER,
      REVIEWER,
    ]);
    // Шагу 3 цитаты шага 2 подаются списком { id, text }.
    expect(textOf(callsOf('analysis_meaning_write')[0].body)).toContain(quotePrint(LINES.never));
  });

  it('an invented quotation is dropped with its reason, the rest is written', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_quotes_write'
        ? {
            ...QUOTES,
            keyQuotes: [...QUOTES.keyQuotes, keyQuote('Anna flew over the mountains.', 1)],
          }
        : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.droppedQuotes).toEqual([
      expect.objectContaining({
        step: 2,
        path: 'keyQuotes.3',
        text: 'Anna flew over the mountains.',
        reason: 'NOT_FOUND',
      }),
    ]);
    const quotes = (await analysisOf(versionId))?.keyQuotes as Array<{ text: string }>;
    expect(quotes.map((q) => q.text)).toEqual([LINES.never, LINES.bell, LINES.leave]);
  });

  it('an answer failing the import DTO: one redo with the field path, then a flag and the block is not written', async () => {
    const versionId = await sourceWithDossier();
    const badCast = {
      ...CAST,
      characters: CAST.characters.map((c) => ({
        ...c,
        key: c.key === 'anna' ? 'Anna Bad' : c.key,
        relations: [],
      })),
    };
    answer = (name) =>
      name === 'analysis_cast_write'
        ? badCast
        : name === 'analysis_quotes_write'
          ? { ...QUOTES, keyQuotes: QUOTES.keyQuotes.map((q) => ({ ...q, speakerKey: '' })) }
          : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    expect(callsOf('analysis_cast_write')).toHaveLength(2);
    const redo = textOf(callsOf('analysis_cast_write')[1].body);
    expect(redo).toContain('IMPORT_INVALID');
    expect(redo).toContain('characters.0.key');
    const run = await runOf(versionId);
    expect(run.steps[0]).toMatchObject({ attempt: 2, verdict: 'flags' });
    const characters = run.items.find((i) => i.step === 1 && i.target === 'characters');
    expect(characters).toMatchObject({ outcome: 'none', failedReason: 'IMPORT_INVALID' });
    expect(characters?.remarks.map((r) => r.where)).toContain('characters.0.key');
    const analysis = await analysisOf(versionId);
    expect(analysis?.characters).toBeNull();
    expect(analysis?.facts).toEqual(CAST.facts);
  });

  it('the editor changed the characters mid-run: their themeKeys come as a proposal, the key quotations are written', async () => {
    const versionId = await sourceWithDossier();
    const edited = CAST.characters.map((c) => ({
      key: c.key,
      name: c.name,
      role: c.role,
      description: `${c.description} Edited.`,
    }));
    answer = async (name) => {
      if (name === 'analysis_quotes_write') {
        await prisma.bookAnalysis.update({
          where: { bookVersionId: versionId },
          data: { characters: edited },
        });
      }
      return defaultAnswer(name);
    };
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(outcomes(run).filter(([, , kind]) => kind === 'links')).toEqual([
      [3, 'characters', 'links', 'proposed'],
      [3, 'keyQuotes', 'links', 'written'],
    ]);
    const analysis = await analysisOf(versionId);
    expect(analysis?.characters).toEqual(edited);
    expect((analysis?.keyQuotes as Array<{ themeKeys?: string[] }>)[0].themeKeys).toEqual(['loss']);
  });

  it('the keys come from the analysis of the source even when another language has a fresher one; same-language versions are not a source', async () => {
    const { bookId, source, translated } = await translatedBook();
    await prisma.bookAnalysis.create({
      data: {
        bookVersionId: source,
        themes: [{ key: 'guilt', title: 'Guilt' }],
        characters: [{ key: 'anna', name: 'Anna', role: 'main' }],
      },
    });
    const es = await prisma.bookVersion.create({ data: versionData(bookId, Language.es) });
    await prisma.bookAnalysis.create({
      data: { bookVersionId: es.id, themes: [{ key: 'grief', title: 'Duelo' }] },
    });
    await start(translated).expect(202);
    await drain();
    const cast = textOf(callsOf('analysis_cast_write')[0].body);
    expect(cast).toContain('theme guilt - Guilt');
    expect(cast).toContain('character anna - Anna');
    expect(cast).not.toContain('grief');
    expect((await runOf(translated)).status).toBe('ready');
  });

  it('no analysis of the source: the keys come from the analysis of another language of the book', async () => {
    const { bookId, translated } = await translatedBook();
    const es = await prisma.bookVersion.create({ data: versionData(bookId, Language.es) });
    await prisma.bookAnalysis.create({
      data: { bookVersionId: es.id, themes: [{ key: 'grief', title: 'Duelo' }] },
    });
    await start(translated).expect(202);
    await drain();
    expect(textOf(callsOf('analysis_cast_write')[0].body)).toContain('theme grief - Duelo');
  });

  it('start refusals: unknown version 404, no chapter text 409 SOURCE_HAS_NO_CHAPTERS, limit below the dossier 400 DRAFT_LIMIT_TOO_LOW', async () => {
    await auth(http().post(base('00000000-0000-4000-8000-000000000000')))
      .send({})
      .expect(404);
    const slug = `f071-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const empty = await prisma.bookVersion.create({
      data: {
        ...versionData(book.id, Language.en),
        chapters: { create: [{ number: 1, title: 'Empty', content: '' }] },
      },
    });
    const noText = await auth(http().post(base(empty.id)))
      .send({})
      .expect(409);
    expect(noText.body.code).toBe('SOURCE_HAS_NO_CHAPTERS');
    const slug2 = `f071-${stamp}-${slugs.length}`;
    slugs.push(slug2);
    const { book: other } = await createBookWithRights(prisma, slug2);
    const noDossier = await prisma.bookVersion.create({ data: versionData(other.id, Language.en) });
    const low = await auth(http().post(base(noDossier.id)))
      .send({ limitUsd: '0' })
      .expect(400);
    expect(low.body.code).toBe('DRAFT_LIMIT_TOO_LOW');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: noDossier.id } })).toBe(0);
  });

  it('a new start discards the previous ready run', async () => {
    const versionId = await sourceWithDossier();
    const first = await start(versionId).expect(202);
    await drain();
    expect((await runOf(versionId)).status).toBe('ready');
    const second = await start(versionId).expect(202);
    expect(second.body.id).not.toBe(first.body.id);
    const old = await prisma.contentDraft.findUniqueOrThrow({
      where: { id: first.body.id as string },
    });
    expect(old.status).toBe('discarded');
  });

  it('Б2: the start transaction takes the analysis lock with the deadline of the analysis writers, not the short draft one (L-020)', async () => {
    const versionId = await sourceWithDossier();
    const transactions = jest.spyOn(prisma, '$transaction');
    await start(versionId).expect(202);
    const options = transactions.mock.calls
      .filter(([fn]) => typeof fn === 'function')
      .map(([, opts]) => opts as unknown);
    expect(options).toEqual([{ timeout: 30_000, maxWait: 10_000 }]);
  });

  it('К1: a paused run - a new start is 409 DRAFT_IN_PROGRESS; cancel of the operation frees it, the new start is 202', async () => {
    const versionId = await sourceWithDossier();
    answer = async (name) => {
      if (name === 'analysis_cast_write') {
        await prisma.llmBudget.update({
          where: { id: LLM_BUDGET_ID },
          data: { ceilingUsd: 0.00001 },
        });
      }
      return defaultAnswer(name);
    };
    const started = await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    expect(run.status).toBe('building');
    expect(started.body.operation.id).toBeDefined();
    const op = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: started.body.operation.id as string },
    });
    expect(op.status).toBe('paused');
    await resetBudget();
    const busy = await start(versionId).expect(409);
    expect(busy.body.code).toBe('DRAFT_IN_PROGRESS');
    await auth(http().post(`/admin/llm/operations/${op.id}/cancel`)).expect(200);
    run = await runOf(versionId);
    expect(run.status).toBe('failed');
    answer = (name) => defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    expect((await runOf(versionId)).status).toBe('ready');
  });

  it('a published version: every block is a proposal, the analysis is not written', async () => {
    const versionId = await sourceWithDossier({ status: 'published' });
    const started = await start(versionId).expect(202);
    expect(started.body.owns).toEqual([]);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.items.filter((i) => !i.links).every((i) => i.outcome === 'proposed')).toBe(true);
    expect(await analysisOf(versionId)).toBeNull();
  });

  it('the core is not collected (no themes): the analysis is written, hasCore = false, step 3 flags CORE_MISSING', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_meaning_write'
        ? { ...MEANING, themes: [], themeLinks: { characters: [], keyQuotes: [] } }
        : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.steps[2].remarks.map((r) => r.code)).toEqual(['CORE_MISSING']);
    const analysis = await analysisOf(versionId);
    expect(analysis).toMatchObject({ hasCore: false, mainIdea: MEANING.mainIdea });
    expect(analysis?.themes).toBeNull();
  });

  /** Ни строки хода, ни операции версии: отказ до записи. */
  const nothingCreated = async (versionId: string) => {
    expect(await prisma.contentDraft.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(
      await prisma.llmOperation.count({ where: { bookVersionId: versionId, kind: 'draft' } }),
    ).toBe(0);
  };

  it('start refusals: no key 503 LLM_DISABLED, the spending ceiling 409 LLM_CEILING_REACHED - nothing is created', async () => {
    const versionId = await sourceWithDossier();
    process.env.OPENROUTER_API_KEY = '';
    const disabled = await start(versionId).expect(503);
    expect(disabled.body.code).toBe('LLM_DISABLED');
    await nothingCreated(versionId);
    // До любой другой проверки: версия без текста глав без ключа - 503, а не 409.
    const slug = `f071-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const empty = await prisma.bookVersion.create({
      data: {
        ...versionData(book.id, Language.en),
        chapters: { create: [{ number: 1, title: 'Empty', content: '' }] },
      },
    });
    const first = await start(empty.id).expect(503);
    expect(first.body.code).toBe('LLM_DISABLED');
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    await prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 1, spentUsd: 1 },
    });
    const ceiling = await start(versionId).expect(409);
    expect(ceiling.body.code).toBe('LLM_CEILING_REACHED');
    await nothingCreated(versionId);
    expect(calls.filter((c) => c.name.startsWith('analysis_'))).toHaveLength(0);
  });

  it('start refused 409 DOSSIER_TOO_LONG when the dossier summary is refused at the estimate; nothing is created', async () => {
    const versionId = await sourceWithDossier();
    const dossiers = app.get<DossierDemandService>(DossierDemandService);
    const real: DossierDemandService['contextEstimate'] = (...args) =>
      DossierDemandService.prototype.contextEstimate.apply(
        dossiers,
        args,
      ) as Promise<ContextEstimate>;
    jest
      .spyOn(dossiers, 'contextEstimate')
      .mockImplementation(async (...args: Parameters<DossierDemandService['contextEstimate']>) => ({
        ...(await real(...args)),
        dossier: {
          estimateUsd: new Prisma.Decimal(1),
          suggestedLimitUsd: new Prisma.Decimal(2),
          upperBound: false,
          refusedTooLong: true,
          sourceVersionId: versionId,
          chapters: 3,
          parts: 1,
        },
      }));
    const estimate = await auth(http().get(`${base(versionId)}/estimate`)).expect(200);
    expect(estimate.body.dossier).toMatchObject({ refusedTooLong: true });
    const refused = await start(versionId).expect(409);
    expect(refused.body.code).toBe('DOSSIER_TOO_LONG');
    await nothingCreated(versionId);
  });

  it('two starts at once: one run is built, the other is 409 DRAFT_IN_PROGRESS (the partial unique index, P2002)', async () => {
    const versionId = await sourceWithDossier();
    const results = await Promise.all([start(versionId), start(versionId)]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('DRAFT_IN_PROGRESS');
    expect(
      await prisma.contentDraft.count({
        where: { bookVersionId: versionId, kind: 'analysis_write', status: 'building' },
      }),
    ).toBe(1);
    // Проигравший старт откатил свою транзакцию: операция одна.
    expect(
      await prisma.llmOperation.count({ where: { bookVersionId: versionId, kind: 'draft' } }),
    ).toBe(1);
  });
});
