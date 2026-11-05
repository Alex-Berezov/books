/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { createServer, Server } from 'node:https';
import { AddressInfo } from 'node:net';
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
import { SourceFetcherService } from '../src/modules/source-fetch/source-fetcher.service';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../src/common/testing/source-fetch-tls-spec';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F07-1b: решения редактора по ходу - «Accept» (хэш блока, themeKeys), «Discard», «Accept all»,
 * отмена хода, «Regenerate» блока, «Continue»; развилка общих ручек `content-drafts/:id/*` по виду строки.
 *
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

  const READER = {
    misreadings: [
      {
        myth: 'The book is only about leaving a town.',
        explanation: 'It is about what leaving costs, as the river scene shows.',
      },
    ],
    discussionQuestions: ['Is Anna free when she leaves?'],
    faq: [
      {
        question: 'What is the book about?',
        answer: 'It is about leaving home and what it costs.',
      },
    ],
  };
  /** Страницы источников: хост задаёт ответ (`about.test` про книгу, `other.test` не про неё, `missing.test` - 404). */
  const sourceUrl = (host: string) => `https://${host}:${sourcePort}/page`;
  const external = (hosts: string[] = ['about.test']) => ({
    genre: 'a novel',
    genreRefs: [0],
    movement: '',
    movementRefs: [],
    writtenYears: '',
    writtenYearsRefs: [],
    context: [{ text: 'The epoch asked who may leave home.', refs: [0] }],
    timeline: [{ year: '1866', event: 'The book was published.', kind: 'book', refs: [0] }],
    reception: [{ text: 'Readers argued about the ending.', refs: [0] }],
    adaptations: [],
    sources: hosts.map((host) => ({ title: `Source ${host}`, url: sourceUrl(host) })),
  });
  let sourceServer: Server;
  let sourcePort = 0;

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
      analysis_reader_write: READER,
      analysis_external_write: external(),
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
    regenerating: boolean;
    regenOperationId?: string | null;
    regenOperationStatus?: string | null;
    regenPauseReason?: string | null;
    regenFailedReason: string | null;
  }
  interface Run {
    id: string;
    status: string;
    operation: { id: string; status: string };
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
    // Фетчер источников ходит по `https.request`, а не через `fetch`: страницы отдаёт локальный
    // HTTPS-сервер, резолвер тестовой сборки сводит любое имя на него (`tech.md` §8).
    sourceServer = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      if (host === 'missing.test') {
        res.writeHead(404, { 'Content-Type': 'text/html' }).end('<p>Not found</p>');
      } else if (host === 'other.test') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>A recipe for soup.</p>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>Book en by Author.</p>');
      }
    });
    await new Promise<void>((resolve) => sourceServer.listen(0, '127.0.0.1', resolve));
    sourcePort = (sourceServer.address() as AddressInfo).port;
    const fetcher = new SourceFetcherService({
      // `down.test` - сервер имён не отвечает (`EAI_AGAIN`): «лёг» канал исполнителя;
      // `nowhere.test` - имени нет (`ENOTFOUND`): модель выдумала адрес, источник плохой.
      lookup: (host) =>
        host === 'down.test'
          ? Promise.reject(
              Object.assign(new Error('getaddrinfo EAI_AGAIN down.test'), { code: 'EAI_AGAIN' }),
            )
          : host === 'nowhere.test'
            ? Promise.reject(
                Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.test'), {
                  code: 'ENOTFOUND',
                }),
              )
            : Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      // Один тестовый сертификат на все имена страниц: цепочка проверяется по `ca`, имя - нет.
      requestOptions: { ca: TEST_TLS_CERT, checkServerIdentity: () => undefined },
      allowPort: sourcePort,
      // Запрет адресов снят только для имён страниц теста, не для всех (`tech.md` §8).
      allowBlockedAddresses: ['about.test', 'other.test', 'missing.test'],
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SourceFetcherService)
      .useValue(fetcher)
      .compile();
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
    await new Promise<void>((resolve) => sourceServer.close(() => resolve()));
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

  it('an empty unpublished version: steps 1-5 write the analysis, the core is ready, themeKeys of step 3 are written into the blocks of steps 1-2 without proposals', async () => {
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
      [4, 'done', 'ok'],
      // Внешний шаг несёт EXTERNAL_CHECK: человек сверяет даты и имена.
      [5, 'done', 'flags'],
    ]);
    expect(run.items.every((i) => i.outcome === 'written')).toBe(true);
    expect(outcomes(run).filter(([, , kind]) => kind === 'links')).toEqual([
      [3, 'characters', 'links', 'written'],
      [3, 'keyQuotes', 'links', 'written'],
    ]);
    const analysis = await analysisOf(versionId);
    expect(analysis?.hasCore).toBe(true);
    expect(analysis?.facts).toEqual({ ...CAST.facts, genre: 'a novel' });
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
    expect(callsOf('analysis_review').map((c) => c.body.model)).toEqual(
      Array.from({ length: 5 }, () => REVIEWER),
    );
    // Шагу 3 цитаты шага 2 подаются списком { id, text }.
    expect(textOf(callsOf('analysis_meaning_write')[0].body)).toContain(quotePrint(LINES.never));
  });

  it('step 4 writes the blocks for the reader; step 5 writes the external blocks with the verified source only, flagged EXTERNAL_CHECK, and the model never gets the book text', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_external_write'
        ? {
            ...external(['about.test', 'other.test']),
            adaptations: [
              { title: 'The film', year: 1970, kind: 'film', differences: 'Shorter.', refs: [1] },
            ],
          }
        : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const analysis = await analysisOf(versionId);
    expect(analysis?.misreadings).toEqual(READER.misreadings);
    expect(analysis?.discussionQuestions).toEqual(READER.discussionQuestions);
    expect(analysis?.faq).toEqual(READER.faq);
    expect(analysis?.facts).toMatchObject({ genre: 'a novel' });
    expect(analysis?.context).toBe('The epoch asked who may leave home.');
    // Экранизация держалась на источнике не про книгу: снята вместе с ним.
    expect(analysis?.adaptations ?? null).toBeNull();
    expect(analysis?.sources).toEqual([
      { title: 'Source about.test', url: sourceUrl('about.test') },
    ]);
    const step5 = run.steps.find((s) => s.step === 5);
    expect(step5?.remarks.map((r) => r.code)).toEqual(expect.arrayContaining(['EXTERNAL_CHECK']));
    expect(step5?.dropped.map((d) => d.code)).toEqual(
      expect.arrayContaining(['SOURCE_UNRELATED', 'SOURCE_UNVERIFIED']),
    );
    expect((run as unknown as { droppedSources: unknown[] }).droppedSources).toEqual([
      { title: 'Source other.test', host: 'other.test', reason: 'SOURCE_UNRELATED' },
    ]);
    // Шаг 5 не читает текст книги.
    const prompt = textOf(callsOf('analysis_external_write')[0].body);
    expect(prompt).not.toContain('BOOK_TEXT');
    expect(prompt).not.toContain(LINES.river);
    // Шаги 4-5 на ядро не влияют.
    expect(analysis?.hasCore).toBe(true);
  });

  it('a source that answers 404: the external blocks are not written, the run is ready, the reason is shown; the core and the blocks of steps 1-4 stay', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_external_write' ? external(['missing.test']) : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    const analysis = await analysisOf(versionId);
    expect(analysis?.hasCore).toBe(true);
    expect(analysis?.faq).toEqual(READER.faq);
    expect(analysis?.context ?? null).toBeNull();
    expect(analysis?.sources ?? null).toBeNull();
    expect(analysis?.facts).not.toHaveProperty('genre');
    expect(
      run.items.filter((i) => i.step === 5).map((i) => [i.target, i.outcome, i.failedReason]),
    ).toEqual(
      expect.arrayContaining([
        ['context', 'none', 'EXTERNAL_UNVERIFIED'],
        ['sources', 'none', 'EXTERNAL_UNVERIFIED'],
      ]),
    );
    expect((run as unknown as { droppedSources: unknown[] }).droppedSources).toEqual([
      { title: 'Source missing.test', host: 'missing.test', reason: 'SOURCE_UNREACHABLE' },
    ]);
  });

  it('no source opens because the channel of the worker is down: step 5 is not decided, the operation pauses STEP_FAILED, nothing external is written', async () => {
    const versionId = await sourceWithDossier();
    // Без тем ядро не собрано: флаг CORE_MISSING ставится после шага 3, а не в конце хода.
    answer = (name) =>
      name === 'analysis_external_write'
        ? external(['down.test'])
        : name === 'analysis_meaning_write'
          ? { ...MEANING, themes: [] }
          : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('building');
    expect(run.operation.status).toBe('paused');
    expect(run.steps.map((s) => s.step)).toEqual([1, 2, 3, 4]);
    expect((run as unknown as { droppedSources: unknown[] }).droppedSources).toEqual([]);
    const analysis = await analysisOf(versionId);
    expect(analysis?.context ?? null).toBeNull();
    expect(run.steps[2].remarks.map((r) => r.code)).toContain('CORE_MISSING');
  });

  it('the model invented every address (no such name): the sources are dropped as unreachable and the run is ready, not paused', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_external_write' ? external(['nowhere.test']) : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect((run as unknown as { droppedSources: unknown[] }).droppedSources).toEqual([
      { title: 'Source nowhere.test', host: 'nowhere.test', reason: 'SOURCE_UNREACHABLE' },
    ]);
    expect((await analysisOf(versionId))?.context ?? null).toBeNull();
  });

  it('one source with an address the import refuses: only that source goes, the statements on the others are written', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_external_write'
        ? {
            ...external(['about.test']),
            context: [{ text: 'The epoch asked who may leave home.', refs: [1] }],
            sources: [
              { title: 'Plain http', url: 'http://about.test/page' },
              { title: 'Source about.test', url: sourceUrl('about.test') },
            ],
          }
        : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const analysis = await analysisOf(versionId);
    expect(analysis?.context).toBe('The epoch asked who may leave home.');
    expect(analysis?.sources).toEqual([
      { title: 'Source about.test', url: sourceUrl('about.test') },
    ]);
    const step5 = (await runOf(versionId)).steps.find((s) => s.step === 5);
    expect(step5?.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'IMPORT_INVALID', path: 'sources.0' }),
      ]),
    );
  });

  it('EXTERNAL_DOUBT without a redo (the second pass failed) does not remove the statement: it stays a flag', async () => {
    const versionId = await sourceWithDossier();
    let externalCalls = 0;
    answer = (name, body) => {
      if (name === 'analysis_external_write' && ++externalCalls > 1) return { broken: true };
      return name === 'analysis_review' &&
        textOf(body).includes('the genre, the context, the timeline')
        ? {
            verdict: 'remarks',
            remarks: [
              { code: 'EXTERNAL_DOUBT', where: 'timeline.0', note: 'The year is doubtful.' },
            ],
          }
        : defaultAnswer(name);
    };
    await start(versionId).expect(202);
    await drain();
    const step5 = (await runOf(versionId)).steps.find((s) => s.step === 5);
    expect(step5?.attempt).toBe(1);
    expect(step5?.remarks.map((r) => r.code)).toContain('EXTERNAL_DOUBT');
    expect((await analysisOf(versionId))?.timeline).toEqual([
      { year: '1866', event: 'The book was published.', kind: 'book' },
    ]);
  });

  it('EXTERNAL_DOUBT that stays after the redo removes the statement: it is not written with a flag', async () => {
    const versionId = await sourceWithDossier();
    answer = (name, body) =>
      name === 'analysis_review' && textOf(body).includes('the genre, the context, the timeline')
        ? {
            verdict: 'remarks',
            remarks: [
              { code: 'EXTERNAL_DOUBT', where: 'timeline.0', note: 'The year is doubtful.' },
            ],
          }
        : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const step5 = run.steps.find((s) => s.step === 5);
    expect(step5?.attempt).toBe(2);
    expect(step5?.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXTERNAL_DOUBT', path: 'timeline.0' }),
      ]),
    );
    const analysis = await analysisOf(versionId);
    expect(analysis?.timeline ?? null).toBeNull();
    expect(analysis?.context).toBe('The epoch asked who may leave home.');
  });

  it('a source with an address the fetcher refuses (an IP literal): no request is made, the block is not written', async () => {
    const versionId = await sourceWithDossier();
    answer = (name) =>
      name === 'analysis_external_write'
        ? {
            ...external(),
            sources: [{ title: 'Local', url: 'https://127.0.0.1/admin' }],
          }
        : defaultAnswer(name);
    await start(versionId).expect(202);
    await drain();
    const analysis = await analysisOf(versionId);
    expect(analysis?.context ?? null).toBeNull();
    expect(analysis?.sources ?? null).toBeNull();
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
    expect(analysis?.facts).toEqual({ ...CAST.facts, genre: 'a novel' });
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

  // ---------------------------------------------------------------------------------------------
  // F07-1b: решения редактора по ходу `ready`.

  const itemOf = (run: Run, target: string, links = false): Item => {
    const found = run.items.find((i) => i.target === target && i.links === links);
    if (!found) throw new Error(`no item ${target}`);
    return found;
  };
  const itemUrl = (run: Run, item: Item, action: string) =>
    `/admin/content-drafts/${run.id}/items/${item.index}/${action}`;
  const decide = (run: Run, target: string, action: string, links = false) =>
    auth(http().post(itemUrl(run, itemOf(run, target, links), action))).send({});
  /** Содержимое предложения - своей ручкой, не в ответе хода (решение арбитра `F07 | F07-1b`, А). */
  interface Proposal {
    text: string | null;
    characters: Array<{ key: string; description: string; themeKeys?: string[] }> | null;
    keyQuotes: unknown[] | null;
    themes: unknown[] | null;
    faq: unknown[] | null;
    sources: Array<{ title: string; url: string }> | null;
  }
  const proposalOf = async (run: Run, item: Item, status = 200) =>
    (await auth(http().get(`/admin/content-drafts/${run.id}/items/${item.index}`)).expect(status))
      .body as Proposal & { code?: string };

  /** Версия опубликована: ход ничего не пишет сам, каждый блок - предложение редактору. */
  const proposedRun = async () => {
    const versionId = await sourceWithDossier({ status: 'published' });
    await start(versionId).expect(202);
    await drain();
    return { versionId, run: await runOf(versionId) };
  };

  const EDITED_CHARACTERS = [
    { key: 'anna', name: 'Anna', role: 'main', description: 'Edited by hand.' },
  ];

  it('Accept: the proposal shows its content; after another block was written meanwhile it succeeds; the themeKeys of the run links are poured by key', async () => {
    const { versionId, run } = await proposedRun();
    const characters = itemOf(run, 'characters');
    expect(characters.outcome).toBe('proposed');
    // Ответ хода содержимого блоков не несёт; предложение - `GET items/:index`, одно поле по виду.
    expect(run.items.every((i) => !('value' in i))).toBe(true);
    const shown = await proposalOf(run, characters);
    expect(shown).toMatchObject({ text: null, keyQuotes: null, themes: null });
    expect(shown.characters?.map((c) => c.key)).toEqual(['anna', 'boris']);
    // Другой блок записан уже после предложения: хэш у каждого блока свой.
    await prisma.bookAnalysis.create({
      data: { bookVersionId: versionId, style: [{ device: 'Repetition', explanation: 'x' }] },
    });
    await decide(run, 'themes', 'accept').expect(200);
    const accepted = await decide(run, 'characters', 'accept').expect(200);
    expect(itemOf(accepted.body as Run, 'characters').outcome).toBe('accepted');
    const analysis = await analysisOf(versionId);
    const stored = analysis?.characters as Array<{ key: string; themeKeys?: string[] }>;
    expect(stored.find((c) => c.key === 'anna')?.themeKeys).toEqual(['loss', 'home']);
    expect(stored.find((c) => c.key === 'boris')?.themeKeys).toEqual(['home']);
    expect(analysis?.style).toEqual([{ device: 'Repetition', explanation: 'x' }]);
    // Принятое второй раз - уже не предложение.
    expect((await decide(run, 'characters', 'accept').expect(409)).body.code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
    // Принятый блок - не предложение: его содержимого ручка не отдаёт.
    expect((await proposalOf(run, characters, 409)).code).toBe('ANALYSIS_ITEM_NOT_PROPOSED');
    const path = `/admin/content-drafts/${run.id}/items/${characters.index}`;
    await auth(http().get(path), 'cm').expect(403);
    await http().get(path).expect(401);
  });

  it('Accept after the editor changed this block: 409 ANALYSIS_BLOCK_CHANGED with the current content, the block stays', async () => {
    const { versionId, run } = await proposedRun();
    await prisma.bookAnalysis.create({
      data: { bookVersionId: versionId, characters: EDITED_CHARACTERS },
    });
    const refused = await decide(run, 'characters', 'accept').expect(409);
    expect(refused.body.code).toBe('ANALYSIS_BLOCK_CHANGED');
    expect(refused.body.current).toEqual(EDITED_CHARACTERS);
    expect((await analysisOf(versionId))?.characters).toEqual(EDITED_CHARACTERS);
    expect(itemOf(await runOf(versionId), 'characters').outcome).toBe('proposed');
  });

  it('Accept the quotations: the themeKeys come by the print of the text and the limit of the import is kept', async () => {
    const { versionId, run } = await proposedRun();
    await decide(run, 'themes', 'accept').expect(200);
    await decide(run, 'characters', 'accept').expect(200);
    await decide(run, 'keyQuotes', 'accept').expect(200);
    const quotes = (await analysisOf(versionId))?.keyQuotes as Array<{
      text: string;
      themeKeys?: string[];
    }>;
    expect(quotes.find((q) => q.text === LINES.never)?.themeKeys).toEqual(['loss']);
    expect(quotes.find((q) => q.text === LINES.bell)?.themeKeys).toEqual(['home']);
    expect(quotes.every((q) => (q.themeKeys ?? []).length <= 8)).toBe(true);
  });

  it('Discard: the proposal is closed and the block is not touched; Accept of it is then 409', async () => {
    const { versionId, run } = await proposedRun();
    const res = await decide(run, 'style', 'discard').expect(200);
    expect(itemOf(res.body as Run, 'style').outcome).toBe('discarded');
    expect(await analysisOf(versionId)).toBeNull();
    expect((await decide(run, 'style', 'accept').expect(409)).body.code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
    expect((await decide(run, 'style', 'discard').expect(409)).body.code).toBe(
      'ANALYSIS_ITEM_NOT_PROPOSED',
    );
    await auth(http().post(`/admin/content-drafts/${run.id}/items/99/accept`))
      .send({})
      .expect(400);
  });

  it('Accept all: interpretations, characters and quotations in the order that keeps the references; a block the editor changed is skipped and stays a proposal, the answer is 200', async () => {
    const { versionId, run } = await proposedRun();
    await prisma.bookAnalysis.create({
      data: { bookVersionId: versionId, style: [{ device: 'Repetition', explanation: 'x' }] },
    });
    const done = await auth(http().post(`/admin/content-drafts/${run.id}/accept-all`))
      .send({})
      .expect(200);
    const left = (done.body as Run).items.filter((i) => i.outcome === 'proposed');
    // Пропущен только блок, который трогал редактор: он - его решением.
    expect(left.map((i) => i.target)).toEqual(['style']);
    expect(itemOf(done.body as Run, 'characters').outcome).toBe('accepted');
    expect((await analysisOf(versionId))?.style).toEqual([
      { device: 'Repetition', explanation: 'x' },
    ]);
    expect((await analysisOf(versionId))?.hasCore).toBe(true);
  });

  it('discard-run: a ready run is closed, the blocks of the analysis stay; the latest run is gone', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    const res = await auth(http().post(`/admin/content-drafts/${run.id}/discard-run`))
      .send({})
      .expect(200);
    expect(res.body.status).toBe('discarded');
    expect(await analysisOf(versionId)).toEqual(before);
    const latest = await auth(http().get(base(versionId))).expect(200);
    expect(latest.body.draft).toBeNull();
    // Закрытый ход решений больше не принимает.
    expect((await decide(run, 'characters', 'discard').expect(409)).body.code).toBe(
      'ANALYSIS_WRITE_NOT_READY',
    );
  });

  it('discard-run of a building run cancels its operation', async () => {
    const versionId = await sourceWithDossier();
    const started = await start(versionId).expect(202);
    const res = await auth(
      http().post(`/admin/content-drafts/${started.body.id as string}/discard-run`),
    )
      .send({})
      .expect(200);
    expect(res.body.status).toBe('discarded');
    const op = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: started.body.operation.id as string },
    });
    expect(op.status).toBe('cancelled');
    await drain();
    expect(await analysisOf(versionId)).toBeNull();
  });

  it('the fork by the kind of the row: a summary run behaves as before, a draft of another kind and an unknown id are 404, the access is admin only', async () => {
    const versionId = await sourceWithDossier();
    const summaryOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'done', bookVersionId: versionId },
    });
    const summaryRun = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind: 'summary_write',
        status: 'ready',
        language: 'en',
        operationId: summaryOp.id,
        data: { items: [] },
      },
    });
    // У хода пересказа своей ручки содержимого нет.
    await auth(http().get(`/admin/content-drafts/${summaryRun.id}/items/0`)).expect(404);
    const noText = await auth(http().post(`/admin/content-drafts/${summaryRun.id}/items/0/accept`))
      .send({})
      .expect(400);
    expect(noText.body.code).toBe('SUMMARY_ITEM_UNKNOWN');
    const discarded = await auth(http().post(`/admin/content-drafts/${summaryRun.id}/discard-run`))
      .send({})
      .expect(200);
    expect(discarded.body).toMatchObject({ id: summaryRun.id, status: 'discarded' });
    // Ответ хода пересказа, а не анализа: его поля (план разделов не задан - `null`).
    expect(discarded.body.plannedSections).toBeNull();
    expect(discarded.body).not.toHaveProperty('stepsTotal');

    const draftOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'done', bookVersionId: versionId },
    });
    const draft = await prisma.contentDraft.create({
      data: {
        bookVersionId: versionId,
        kind: 'analysis',
        status: 'ready',
        language: 'en',
        operationId: draftOp.id,
      },
    });
    for (const path of [
      `/admin/content-drafts/${draft.id}/items/0/accept`,
      `/admin/content-drafts/${draft.id}/items/0/discard`,
      `/admin/content-drafts/${draft.id}/items/0/regenerate`,
      `/admin/content-drafts/${draft.id}/discard-run`,
      `/admin/content-drafts/${draft.id}/accept-all`,
      '/admin/content-drafts/00000000-0000-4000-8000-000000000000/accept-all',
    ]) {
      await auth(http().post(path)).send({}).expect(404);
      await auth(http().post(path), 'cm').send({}).expect(403);
      await auth(http().post(path), 'user').send({}).expect(403);
      await http().post(path).send({}).expect(401);
    }
    expect((await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'ready',
    );
  });

  it('Regenerate: the prompt carries the block, its keys and the remark; the saved block stays, the result is a proposal with the links poured back; Accept writes it', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'characters').outcome).toBe('written');
    const before = await analysisOf(versionId);
    calls.length = 0;
    answer = (name, body) =>
      name === 'analysis_cast_write' && textOf(body).includes('CURRENT_BLOCK')
        ? {
            ...CAST,
            characters: CAST.characters.map((c) => ({
              ...c,
              description: `${c.description} Rewritten.`,
            })),
          }
        : defaultAnswer(name);
    const res = await auth(http().post(itemUrl(run, itemOf(run, 'characters'), 'regenerate')))
      .send({ remark: 'Make it shorter' })
      .expect(202);
    expect(itemOf(res.body as Run, 'characters')).toMatchObject({ regenerating: true });
    // Вторая перегенерация того же блока до конца первой - 409.
    const second = await auth(http().post(itemUrl(run, itemOf(run, 'characters'), 'regenerate')))
      .send({})
      .expect(409);
    expect(second.body.code).toBe('ANALYSIS_REGEN_IN_PROGRESS');
    expect((await decide(run, 'characters', 'discard').expect(409)).body.code).toBe(
      'ANALYSIS_REGEN_IN_PROGRESS',
    );
    await drain();
    const cast = callsOf('analysis_cast_write');
    expect(cast).toHaveLength(1);
    const prompt = textOf(cast[0].body);
    expect(prompt).toContain('Make it shorter');
    expect(prompt).toContain('"key":"anna"');
    expect(prompt).toContain('"key":"boris"');

    const after = await runOf(versionId);
    const characters = itemOf(after, 'characters');
    expect(characters).toMatchObject({ outcome: 'proposed', regenerating: false });
    // Одно поле по виду блока: у героев - `characters`, остальные поля пусты.
    const shown = await proposalOf(after, characters);
    expect(shown).toMatchObject({ text: null, keyQuotes: null, themes: null });
    const proposal = shown.characters ?? [];
    expect(proposal.map((c) => c.key)).toEqual(['anna', 'boris']);
    expect(proposal[0].description).toContain('Rewritten.');
    // Связи тем шага 3 влиты заново по ключам.
    expect(proposal[0].themeKeys).toEqual(['loss', 'home']);
    expect((await analysisOf(versionId))?.characters).toEqual(before?.characters);
    // Другие блоки шага не меняются: подполя карточки остались как были записаны.
    expect(itemOf(after, 'facts.narrator').outcome).toBe('written');
    expect((await analysisOf(versionId))?.facts).toEqual(before?.facts);

    await decide(after, 'characters', 'accept').expect(200);
    const written = (await analysisOf(versionId))?.characters as Array<{ description: string }>;
    expect(written[0].description).toContain('Rewritten.');
  });

  it('Regenerate: the theme links and the sources are refused 409; an unknown block 400', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    for (const [target, links] of [
      ['characters', true],
      // Источники переписываются вместе с блоком шага 5 (решение арбитра `F07 | F07-2b`).
      ['sources', false],
    ] as const) {
      const refused = await decide(run, target, 'regenerate', links).expect(409);
      expect(refused.body.code).toBe('ANALYSIS_ITEM_NOT_REGENERABLE');
    }
    await auth(http().post(`/admin/content-drafts/${run.id}/items/99/regenerate`))
      .send({})
      .expect(400);
  });

  it('F07-2b: Regenerate of the themes keeps their keys; the characters and quotations keep no dangling theme key; Accept pours the new links', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    calls.length = 0;
    answer = (name, body) =>
      name === 'analysis_meaning_write' && textOf(body).includes('CURRENT_BLOCK')
        ? {
            ...MEANING,
            themes: MEANING.themes.map((t) => ({
              ...t,
              interpretation: `${t.interpretation} Rewritten.`,
            })),
            themeLinks: {
              characters: [{ key: 'boris', themeKeys: ['loss'] }],
              keyQuotes: [],
            },
          }
        : defaultAnswer(name);
    await auth(http().post(itemUrl(run, itemOf(run, 'themes'), 'regenerate')))
      .send({ remark: 'Deeper' })
      .expect(202);
    await drain();
    const meaning = callsOf('analysis_meaning_write');
    expect(meaning).toHaveLength(1);
    expect(textOf(meaning[0].body)).toContain('"key":"loss"');
    // Замечание редактора доходит до автора и на шаге 3.
    expect(textOf(meaning[0].body)).toContain('Deeper');
    // Проверяющей сказано, что переписан один блок.
    expect(
      callsOf('analysis_review').some((c) =>
        textOf(c.body).includes('Only the block "themes" was rewritten'),
      ),
    ).toBe(true);
    const after = await runOf(versionId);
    const themes = itemOf(after, 'themes');
    expect(themes).toMatchObject({ outcome: 'proposed', regenerating: false });
    const proposal = (await proposalOf(after, themes)).themes as Array<{ key: string }>;
    expect(proposal.map((t) => t.key)).toEqual(['loss', 'home']);
    // До «Accept» анализ не тронут: другие блоки не меняются.
    expect(await analysisOf(versionId)).toMatchObject({
      themes: before?.themes,
      characters: before?.characters,
      keyQuotes: before?.keyQuotes,
    });
    await decide(after, 'themes', 'accept').expect(200);
    const saved = await analysisOf(versionId);
    const keys = new Set((saved?.themes as Array<{ key: string }>).map((t) => t.key));
    const linked = [
      ...(saved?.characters as Array<{ key: string; themeKeys?: string[] }>),
      ...(saved?.keyQuotes as Array<{ themeKeys?: string[] }>),
    ].flatMap((e) => e.themeKeys ?? []);
    expect(linked.filter((k) => !keys.has(k))).toEqual([]);
    // Новые связи влиты в героев, которыми ход владеет: Борис получил «loss».
    const boris = (saved?.characters as Array<{ key: string; themeKeys?: string[] }>).find(
      (c) => c.key === 'boris',
    );
    expect(boris?.themeKeys).toEqual(['home', 'loss']);
  });

  it('F07-2b: Regenerate of the themes that renames a linked theme: a redo by the code remark, then a proposal flagged IMPORT_INVALID; Accept is refused', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    calls.length = 0;
    answer = (name, body) =>
      name === 'analysis_meaning_write' && textOf(body).includes('CURRENT_BLOCK')
        ? { ...MEANING, themes: [theme('grief', 'Grief'), theme('home', 'Home')] }
        : defaultAnswer(name);
    await auth(http().post(itemUrl(run, itemOf(run, 'themes'), 'regenerate')))
      .send({})
      .expect(202);
    await drain();
    const meaning = callsOf('analysis_meaning_write');
    expect(meaning).toHaveLength(2);
    expect(textOf(meaning[1].body)).toContain('"loss"');
    const themes = itemOf(await runOf(versionId), 'themes');
    expect(themes).toMatchObject({ outcome: 'proposed', verdict: 'flags' });
    expect(themes.remarks.map((r) => r.code)).toContain('IMPORT_INVALID');
    expect((await decide(await runOf(versionId), 'themes', 'accept').expect(409)).body.code).toBe(
      'ANALYSIS_WRITE_REFUSED',
    );
    expect((await analysisOf(versionId))?.themes).toEqual(before?.themes);
  });

  it('F07-2b: Regenerate of a step 4 block: the new block is a proposal, the other blocks of the step stay', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    answer = (name, body) =>
      name === 'analysis_reader_write' && textOf(body).includes('CURRENT_BLOCK')
        ? {
            ...READER,
            faq: [{ question: 'Why does Anna leave?', answer: 'She leaves to stay herself.' }],
          }
        : defaultAnswer(name);
    calls.length = 0;
    await auth(http().post(itemUrl(run, itemOf(run, 'faq'), 'regenerate')))
      .send({ remark: 'Ask about the ending' })
      .expect(202);
    await drain();
    expect(textOf(callsOf('analysis_reader_write')[0].body)).toContain('Ask about the ending');
    const after = await runOf(versionId);
    const faq = itemOf(after, 'faq');
    expect(faq.outcome).toBe('proposed');
    expect((await proposalOf(after, faq)).faq).toEqual([
      { question: 'Why does Anna leave?', answer: 'She leaves to stay herself.' },
    ]);
    expect(await analysisOf(versionId)).toMatchObject({
      faq: before?.faq,
      misreadings: before?.misreadings,
      discussionQuestions: before?.discussionQuestions,
    });
    await decide(after, 'faq', 'accept').expect(200);
    expect((await analysisOf(versionId))?.faq).toEqual([
      { question: 'Why does Anna leave?', answer: 'She leaves to stay herself.' },
    ]);
  });

  it('F07-2b: Regenerate of a step 5 block opens its sources again; Accept adds the new verified source to the saved ones by url, the unrelated one is dropped with its statement', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    expect(before?.sources).toEqual([{ title: 'Source about.test', url: sourceUrl('about.test') }]);
    const second = `https://about.test:${sourcePort}/second`;
    answer = (name, body) =>
      name === 'analysis_external_write' && textOf(body).includes('CURRENT_BLOCK')
        ? {
            ...external(['about.test', 'other.test']),
            sources: [
              { title: 'Source about.test', url: sourceUrl('about.test') },
              { title: 'Unrelated', url: sourceUrl('other.test') },
              { title: 'Second', url: second },
            ],
            context: [
              { text: 'The epoch asked who may leave home, and answered no.', refs: [0, 2] },
              { text: 'A paragraph on the unrelated page only.', refs: [1] },
            ],
          }
        : defaultAnswer(name);
    calls.length = 0;
    await auth(http().post(itemUrl(run, itemOf(run, 'context'), 'regenerate')))
      .send({ remark: 'Name the epoch' })
      .expect(202);
    await drain();
    // Замечание редактора доходит до автора внешнего шага.
    expect(textOf(callsOf('analysis_external_write')[0].body)).toContain('Name the epoch');
    const after = await runOf(versionId);
    const context = itemOf(after, 'context');
    expect(context.outcome).toBe('proposed');
    // Перегенерированный внешний блок несёт флаг «сверить факты», как записанный ходом.
    expect(context.verdict).toBe('flags');
    expect(context.remarks.map((r) => r.code)).toContain('EXTERNAL_CHECK');
    const shown = await proposalOf(after, context);
    expect(shown.text).toBe('The epoch asked who may leave home, and answered no.');
    expect((shown.sources ?? []).map((s) => s.url)).toEqual([sourceUrl('about.test'), second]);
    expect((await analysisOf(versionId))?.sources).toEqual(before?.sources);
    await decide(after, 'context', 'accept').expect(200);
    const saved = await analysisOf(versionId);
    expect(saved?.context).toBe('The epoch asked who may leave home, and answered no.');
    expect((saved?.sources as Array<{ url: string }>).map((s) => s.url)).toEqual([
      sourceUrl('about.test'),
      second,
    ]);
    // Другие внешние блоки не меняются.
    expect(saved?.timeline).toEqual(before?.timeline);
    expect(saved?.reception).toEqual(before?.reception);
  });

  it('F07-2b: Regenerate of a step 5 block whose every statement lost its source: the block stays, the reason is shown', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    answer = (name, body) =>
      name === 'analysis_external_write' && textOf(body).includes('CURRENT_BLOCK')
        ? { ...external(['missing.test']) }
        : defaultAnswer(name);
    await auth(http().post(itemUrl(run, itemOf(run, 'context'), 'regenerate')))
      .send({})
      .expect(202);
    await drain();
    const context = itemOf(await runOf(versionId), 'context');
    expect(context).toMatchObject({
      outcome: 'written',
      regenerating: false,
      regenFailedReason: 'EXTERNAL_UNVERIFIED',
    });
    expect(await analysisOf(versionId)).toMatchObject({
      context: before?.context,
      sources: before?.sources,
    });
  });

  it('Regenerate drops a character the saved quotations still point at: the result is a proposal flagged IMPORT_INVALID with the path, the saved characters stay, the keys of the rest are kept', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const before = await analysisOf(versionId);
    answer = (name, body) =>
      name === 'analysis_cast_write' && textOf(body).includes('CURRENT_BLOCK')
        ? { ...CAST, characters: [{ ...CAST.characters[0], relations: [] }] }
        : defaultAnswer(name);
    await auth(http().post(itemUrl(run, itemOf(run, 'characters'), 'regenerate')))
      .send({})
      .expect(202);
    await drain();
    const after = await runOf(versionId);
    const characters = itemOf(after, 'characters');
    expect(characters).toMatchObject({ outcome: 'proposed', verdict: 'flags' });
    expect(characters.remarks.map((r) => r.code)).toContain('IMPORT_INVALID');
    expect(characters.remarks.find((r) => r.code === 'IMPORT_INVALID')?.where).toContain(
      'keyQuotes',
    );
    expect((await proposalOf(after, characters)).characters?.map((c) => c.key)).toEqual(['anna']);
    expect((await analysisOf(versionId))?.characters).toEqual(before?.characters);
    // Принять такое предложение анализ не даёт: ссылки на слитом объекте не сходятся.
    const refused = await decide(after, 'characters', 'accept').expect(409);
    expect(refused.body.code).toBe('ANALYSIS_WRITE_REFUSED');
    expect((await analysisOf(versionId))?.characters).toEqual(before?.characters);
  });

  it('Regenerate: cancel from the operations page clears the mark and the run stays ready; Continue of a paused regeneration finishes it', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    const first = await auth(http().post(itemUrl(run, itemOf(run, 'style'), 'regenerate')))
      .send({})
      .expect(202);
    expect(itemOf(first.body as Run, 'style')).toMatchObject({
      regenerating: true,
      regenOperationStatus: 'active',
      regenPauseReason: null,
    });
    const op = await prisma.llmOperation.findFirstOrThrow({
      where: { bookVersionId: versionId, kind: 'draft', status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    await auth(http().post(`/admin/llm/operations/${op.id}/cancel`)).expect(200);
    run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(itemOf(run, 'style').regenerating).toBe(false);

    await auth(http().post(itemUrl(run, itemOf(run, 'style'), 'regenerate')))
      .send({})
      .expect(202);
    const paused = await prisma.llmOperation.findFirstOrThrow({
      where: { bookVersionId: versionId, kind: 'draft', status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe(
      'paused',
    );
    // Состояние операции перегенерации - в ответе хода значением.
    expect(itemOf(await runOf(versionId), 'style')).toMatchObject({
      regenerating: true,
      regenOperationId: paused.id,
      regenOperationStatus: 'paused',
      regenPauseReason: 'CEILING_REACHED',
    });
    await resetBudget();
    await auth(http().post(`/admin/llm/operations/${paused.id}/resume`))
      .send({})
      .expect(200);
    await drain();
    run = await runOf(versionId);
    expect(itemOf(run, 'style')).toMatchObject({ regenerating: false, outcome: 'proposed' });
    expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe(
      'done',
    );
  });

  it('Continue of a paused run puts the analysis_write task and the run finishes; no role - 403, nothing is enqueued', async () => {
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
    const opId = started.body.operation.id as string;
    expect((await runOf(versionId)).operation.status).toBe('paused');
    await resetBudget();
    answer = (name) => defaultAnswer(name);
    const tasksOf = () =>
      prisma.llmTask.count({ where: { operationId: opId, kind: 'analysis_write' } });
    const before = await tasksOf();
    await auth(http().post(`/admin/llm/operations/${opId}/resume`), 'cm')
      .send({})
      .expect(403);
    await auth(http().post(`/admin/llm/operations/${opId}/resume`), 'user')
      .send({})
      .expect(403);
    expect(await tasksOf()).toBe(before);
    await auth(http().post(`/admin/llm/operations/${opId}/resume`))
      .send({})
      .expect(200);
    expect(await tasksOf()).toBe(before + 1);
    const pending = await prisma.llmTask.findFirstOrThrow({
      where: { operationId: opId, kind: 'analysis_write', status: 'pending' },
    });
    expect(pending.payload).toEqual({ draftId: started.body.id as string });
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.items.every((i) => i.outcome === 'written')).toBe(true);
  });

  it('a new start while a regeneration of the previous run is running: the previous run is discarded, its regeneration operation cancelled and its mark cleared', async () => {
    const versionId = await sourceWithDossier();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    await auth(http().post(itemUrl(run, itemOf(run, 'style'), 'regenerate')))
      .send({})
      .expect(202);
    const regenOp = await prisma.llmOperation.findFirstOrThrow({
      where: { bookVersionId: versionId, kind: 'draft', status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    // Новый старт - без исполнения перегенерации: отметка ещё стоит на блоке прежнего хода.
    await start(versionId).expect(202);
    expect(
      (await prisma.llmOperation.findUniqueOrThrow({ where: { id: regenOp.id } })).status,
    ).toBe('cancelled');
    const old = await prisma.contentDraft.findUniqueOrThrow({ where: { id: run.id } });
    expect(old.status).toBe('discarded');
    const items = (old.data as { items: Array<{ target: string; regen: unknown }> }).items;
    expect(items.find((i) => i.target === 'style')?.regen).toBeNull();
  });
});
