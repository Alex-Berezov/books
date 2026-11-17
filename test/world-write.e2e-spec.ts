/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { createServer, Server } from 'node:https';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { SourceFetcherService } from '../src/modules/source-fetch/source-fetcher.service';
import { WorldMentionsService } from '../src/modules/book-world/world-mentions.service';
import { WorldMentionsSchedulerService } from '../src/modules/book-world/world-mentions-scheduler.service';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../src/common/testing/source-fetch-tls-spec';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F08-4a: ход «Write World» на подменённом OpenRouter - герои `main` анализа версии (ключи - из
 * анализа), формы имени по тексту, страница героя циклом качества, внешние блоки с проверкой
 * источников, запись через импорт мира (новые сущности и пустые блоки неопубликованной - сразу,
 * остальное - предложения), «Accept», права и отказы старта. Исполнитель на базе, проходы руками.
 */
describe('World run «Write World» (e2e)', () => {
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

  const person = (name: string) => ({
    name,
    variants: [],
    gender: 'female',
    whoIs: 'heroine',
    address: [],
    relations: [],
  });
  const PART = {
    summary: 'Something happens.',
    characters: [person('Anna'), person('Boris')],
    entities: [],
    events: [{ event: 'Anna leaves', orderNote: '' }],
    voice: { notes: 'calm', devices: [] },
    motifs: [],
  };
  const DOSSIER = {
    characters: [
      { ...person('Anna'), key: 'anna', firstChapter: 1, fate: 'leaves', role: 'main' },
      { ...person('Boris'), key: 'boris', firstChapter: 1, fate: 'stays', role: 'main' },
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

  /** Строки глав - дословные цитаты ответов модели. Анны нет во второй главе. */
  const LINES = {
    river: 'Anna walked along the cold river at dawn.',
    never: 'I will never come back to this town, said Anna.',
    bridge: 'Boris watched his sister from the old bridge.',
    bell: 'Boris rang the old bell three times over the square.',
    silent: 'Boris said nothing to anyone that day.',
    leave: 'At last Anna closed the door and left the town for good.',
    stayed: 'Boris stayed by the bell when she was gone.',
  };
  const CHAPTERS = [
    {
      number: 1,
      title: 'The River',
      content: `<p>${LINES.river}</p><p>${LINES.never}</p><p>${LINES.bridge}</p>`,
    },
    { number: 2, title: 'The Bell', content: `<p>${LINES.bell}</p><p>${LINES.silent}</p>` },
    { number: 3, title: 'The Door', content: `<p>${LINES.leave}</p><p>${LINES.stayed}</p>` },
  ];
  const ANALYSIS_CHARACTERS = [
    {
      key: 'anna',
      name: 'Anna',
      role: 'main',
      description: 'Anna is a young woman who wants to leave the town of her childhood.',
    },
    {
      key: 'boris',
      name: 'Boris',
      role: 'main',
      description: 'Boris is her brother who stays and keeps ringing the old bell.',
    },
    { key: 'clerk', name: 'The clerk', role: 'minor', description: 'A clerk at the station.' },
  ];

  const SELECT = {
    characters: [
      // «Annushka» в тексте нет - форма отбрасывается кодом.
      { key: 'anna', name: 'Anna', aliases: ['Anna', 'Annushka'] },
      { key: 'boris', name: 'Boris', aliases: ['Boris'] },
      // Не кандидат (не `main`) - отбрасывается.
      { key: 'clerk', name: 'The clerk', aliases: ['clerk'] },
    ],
  };
  const quote = (text: string, chapter: number, speakerKey = '') => ({
    text,
    chapter,
    speakerKey,
    interpretation: 'The line shows how the character holds to the town or breaks with it.',
  });
  const scene = (chapter: number, title: string) => ({
    chapter,
    title,
    text: `In this scene the character shows what the town means to them (${title}).`,
  });
  const page = (key: 'anna' | 'boris', patch: Record<string, unknown> = {}) => ({
    name: key === 'anna' ? 'Anna' : 'Boris',
    short:
      key === 'anna'
        ? 'Anna is a young woman of a small river town who dreams of a life elsewhere.'
        : 'Boris is the brother of Anna who rings the bell of the town square.',
    profile: { position: key === 'anna' ? 'the sister' : 'the bell ringer', relationToMain: '' },
    appearance: '',
    character:
      key === 'anna'
        ? 'Anna is restless: at the river she already looks past the town, and her vow to never come back is said aloud.'
        : 'Boris is steady and silent: he rings the bell day after day and does not leave the square.',
    arc: {
      from: key === 'anna' ? 'bound to the town' : 'the keeper of the bell',
      to: key === 'anna' ? 'free of it' : 'alone by the bell',
      stages: [],
    },
    scenes:
      key === 'anna'
        ? [scene(1, 'At the river'), scene(3, 'The closed door')]
        : [scene(2, 'The bell'), scene(3, 'After she leaves')],
    relations: [{ to: key === 'anna' ? 'boris' : 'anna', label: 'sibling' }],
    quotes:
      key === 'anna'
        ? [
            quote(LINES.river, 1, 'anna'),
            quote(LINES.never, 1, 'anna'),
            quote(LINES.leave, 3),
            // Выдуманная цитата: дословно её в главе нет.
            quote('Anna sang a song nobody ever heard.', 3),
          ]
        : [quote(LINES.bell, 2), quote(LINES.silent, 2), quote(LINES.stayed, 3)],
    faq: [],
    ...patch,
  });
  const sourceUrl = (host: string) => `https://${host}:${sourcePort}/page`;
  const EXTERNAL = () => ({
    critique: { text: 'Critics read the character as the voice of the generation.', refs: [0] },
    // Держится только на источнике, который не открылся: снимается.
    prototypes: { text: 'The prototype is said to be a sister of the author.', refs: [1] },
    adaptations: [],
    sources: [
      { title: 'Source about.test', url: sourceUrl('about.test') },
      { title: 'Source missing.test', url: sourceUrl('missing.test') },
    ],
  });
  const OK_REVIEW = { verdict: 'ok', remarks: [] };

  let sourceServer: Server;
  let sourcePort = 0;
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let mentions: WorldMentionsService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();
  const slugs: string[] = [];
  interface ChatBody {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { json_schema?: { name?: string } };
  }
  const calls: Array<{ name: string; body: ChatBody }> = [];
  const callsOf = (name: string) => calls.filter((c) => c.name === name);
  const textOf = (body: ChatBody) => body.messages.map((m) => m.content).join('\n');
  /** Герой вызова страницы или внешних блоков - по огороженному блоку `CHARACTER`. */
  const heroOf = (body: ChatBody): string => /<<<CHARACTER\w*\n(\w+)/.exec(textOf(body))?.[1] ?? '';
  const defaultAnswer = (name: string, body: ChatBody): unknown => {
    if (name === 'world_page_write') return page(heroOf(body) === 'boris' ? 'boris' : 'anna');
    return {
      dossier_part: PART,
      dossier: DOSSIER,
      world_select: SELECT,
      world_external_write: EXTERNAL(),
      world_review: OK_REVIEW,
    }[name];
  };
  let answer: (name: string, body: ChatBody) => unknown = defaultAnswer;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);
  const drain = async () => {
    for (let i = 0; i < 150; i++) {
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

  /** Версия с тремя главами, готовым досье и анализом с героями `main` (или без анализа). */
  const version = async (
    options: {
      language?: Language;
      analysis?: boolean;
      dossier?: boolean;
      characters?: Array<Record<string, string>>;
    } = {},
  ): Promise<string> => {
    const slug = `f084-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const created = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: options.language ?? Language.en,
        title: 'Book en',
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
    if (options.analysis !== false) {
      await prisma.bookAnalysis.create({
        data: {
          bookVersionId: created.id,
          characters: options.characters ?? ANALYSIS_CHARACTERS,
        },
      });
    }
    if ((options.language ?? Language.en) === Language.en && options.dossier !== false) {
      await auth(http().post(`/admin/versions/${created.id}/dossier`))
        .send({})
        .expect(202);
      await drain();
    }
    calls.length = 0;
    return created.id;
  };

  const base = (versionId: string) => `/admin/versions/${versionId}/drafts/world_write`;
  const start = (versionId: string) => auth(http().post(base(versionId))).send({});
  interface Item {
    index: number;
    key: string;
    block: string;
    step: number;
    verdict: string;
    remarks: Array<{ code: string; where: string }>;
    outcome: string;
    failedReason: string | null;
    regenerating: boolean;
    regenFailedReason: string | null;
  }
  interface Run {
    id: string;
    status: string;
    failedReason: string | null;
    operation: { id: string; status: string; pauseReason: string | null };
    stepsTotal: number | null;
    candidates: Array<{ key: string; name: string; aliases: string[]; chapters: number[] }>;
    steps: Array<{
      step: number;
      kind: string;
      key: string | null;
      verdict: string;
      remarks: Array<{ code: string; where: string }>;
      attempt: number;
      outcome: string;
      dropped: Array<{ code: string; path: string }>;
    }>;
    items: Item[];
    droppedQuotes: Array<{ key: string; text: string; reason: string }>;
    droppedSources: Array<{ key: string; host: string; reason: string }>;
  }
  const runOf = async (versionId: string): Promise<Run> => {
    const res = await auth(http().get(base(versionId))).expect(200);
    const run = (res.body as { draft: Run | null }).draft;
    if (!run) throw new Error(`no run of ${versionId}`);
    return run;
  };
  const entityOf = (versionId: string, key: string) =>
    prisma.bookWorldEntity.findUnique({
      where: { bookVersionId_key: { bookVersionId: versionId, key } },
    });
  const itemOf = (run: Run, key: string, block: string) => {
    const item = run.items.find((i) => i.key === key && i.block === block);
    if (!item) throw new Error(`no item ${key}.${block}`);
    return item;
  };
  const putEntity = (versionId: string, key: string, body: Record<string, unknown>) =>
    auth(http().put(`/versions/${versionId}/world/${key}`)).send({
      language: 'en',
      type: 'character',
      ...body,
    });

  const resetBudget = () =>
    prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0, defaultRunLimitUsd: 10 },
    });

  beforeAll(async () => {
    // Страницы источников - локальный HTTPS-сервер: `about.test` про книгу, `missing.test` - 404.
    sourceServer = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      if (host === 'missing.test') {
        res.writeHead(404, { 'Content-Type': 'text/html' }).end('<p>Not found</p>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>Book en by Author.</p>');
      }
    });
    await new Promise<void>((resolve) => sourceServer.listen(0, '127.0.0.1', resolve));
    sourcePort = (sourceServer.address() as AddressInfo).port;
    const fetcher = new SourceFetcherService({
      // `down.test` - сервер имён не отвечает (`EAI_AGAIN`): «лёг» канал исполнителя.
      lookup: (host) =>
        host === 'down.test'
          ? Promise.reject(
              Object.assign(new Error('getaddrinfo EAI_AGAIN down.test'), { code: 'EAI_AGAIN' }),
            )
          : Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      requestOptions: { ca: TEST_TLS_CERT, checkServerIdentity: () => undefined },
      allowPort: sourcePort,
      allowBlockedAddresses: ['about.test', 'missing.test'],
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
    mentions = app.get(WorldMentionsService);
    // Пересчёт присутствия - руками: фоновый планировщик не вмешивается в проверки.
    await app.get(WorldMentionsSchedulerService).onModuleDestroy();
    const emails = {
      admin: `f084-admin-${stamp}@test.com`,
      cm: `f084-cm-${stamp}@test.com`,
      user: `f084-user-${stamp}@test.com`,
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
    answer = defaultAnswer;
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
    const versionId = await version();
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

  it('refusals: no analysis or no main character - 409 WORLD_ANALYSIS_MISSING; a version not in ru/en - 409 WORLD_LANGUAGE_UNSUPPORTED', async () => {
    const bare = await version({ analysis: false });
    for (const path of [`${base(bare)}/estimate`, base(bare)]) {
      const res = await auth(path.endsWith('estimate') ? http().get(path) : http().post(path))
        .send({})
        .expect(409);
      expect(res.body.code).toBe('WORLD_ANALYSIS_MISSING');
    }
    await prisma.bookAnalysis.create({
      data: { bookVersionId: bare, characters: [ANALYSIS_CHARACTERS[2]] },
    });
    expect((await start(bare).expect(409)).body.code).toBe('WORLD_ANALYSIS_MISSING');
    const fr = await version({ language: Language.fr });
    expect((await start(fr).expect(409)).body.code).toBe('WORLD_LANGUAGE_UNSUPPORTED');
    expect((await auth(http().get(`${base(fr)}/estimate`)).expect(409)).body.code).toBe(
      'WORLD_LANGUAGE_UNSUPPORTED',
    );
    expect(calls).toHaveLength(0);
  });

  it('an empty version: the pages of both main characters are written with the keys of the analysis, the core is complete after the recount, the invented quotation and the name form not in the text are dropped with their reason', async () => {
    const versionId = await version();
    const estimate = await auth(http().get(`${base(versionId)}/estimate`)).expect(200);
    expect(estimate.body).toMatchObject({ candidates: 2, dossier: null, glossary: null });
    expect(Number(estimate.body.stageUsd)).toBeGreaterThan(0);
    await start(versionId).expect(202);
    await drain();

    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    expect(run.stepsTotal).toBe(5);
    // Ключи - из анализа версии, только герои `main`; присутствие посчитано кодом до страницы.
    expect(run.candidates.map((c) => [c.key, c.aliases, c.chapters])).toEqual([
      ['anna', ['Anna'], [1, 3]],
      ['boris', ['Boris'], [1, 2, 3]],
    ]);
    expect(run.steps[0].dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ALIAS_NOT_IN_TEXT' }),
        expect.objectContaining({ code: 'KEY_UNKNOWN' }),
      ]),
    );
    expect(run.steps.map((s) => [s.kind, s.key, s.outcome])).toEqual([
      ['select', null, 'done'],
      ['page', 'anna', 'done'],
      ['external', 'anna', 'done'],
      ['page', 'boris', 'done'],
      ['external', 'boris', 'done'],
    ]);
    expect(run.droppedQuotes).toEqual([
      expect.objectContaining({
        key: 'anna',
        text: 'Anna sang a song nobody ever heard.',
        reason: 'QUOTE_NOT_VERBATIM',
      }),
    ]);
    expect(run.items.filter((i) => i.outcome === 'proposed')).toEqual([]);

    await mentions.recountVersion(versionId);
    for (const key of ['anna', 'boris']) {
      const entity = await entityOf(versionId, key);
      expect(entity).toMatchObject({ type: 'character', role: 'main', hasCore: true });
      expect(entity?.autoTextAt).not.toBeNull();
    }
    const anna = await entityOf(versionId, 'anna');
    const blocks = anna?.blocks as { quotes: Array<{ text: string }> };
    expect(blocks.quotes.map((q) => q.text)).toEqual([LINES.river, LINES.never, LINES.leave]);
    expect(anna?.aliases).toEqual(['Anna']);
    // Проверяющая - другого семейства; шаг без замечаний - без переделки.
    expect(callsOf('world_page_write')).toHaveLength(2);
    expect(new Set(callsOf('world_review').map((c) => c.body.model))).toEqual(new Set([REVIEWER]));
  });

  it('external blocks: a statement whose only source did not open is dropped, the kept one is written with its checked source and flagged EXTERNAL_CHECK; the external step gets no book text', async () => {
    const versionId = await version();
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(itemOf(run, 'anna', 'critique')).toMatchObject({ outcome: 'written' });
    expect(itemOf(run, 'anna', 'critique').remarks.map((r) => r.code)).toContain('EXTERNAL_CHECK');
    expect(itemOf(run, 'anna', 'prototypes')).toMatchObject({
      outcome: 'none',
      failedReason: 'EXTERNAL_UNVERIFIED',
    });
    expect(run.droppedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'anna',
          host: 'missing.test',
          reason: 'SOURCE_UNREACHABLE',
        }),
      ]),
    );
    const anna = await entityOf(versionId, 'anna');
    expect(anna?.sources).toEqual([{ title: 'Source about.test', url: sourceUrl('about.test') }]);
    expect((anna?.blocks as { prototypes?: string }).prototypes).toBeUndefined();
    for (const call of callsOf('world_external_write')) {
      expect(textOf(call.body)).not.toContain(LINES.river);
    }
  });

  it('a scene in a chapter without the character: one redo, then the flag; the scene is still written', async () => {
    const versionId = await version();
    answer = (name, body) =>
      name === 'world_page_write' && heroOf(body) === 'anna'
        ? page('anna', { scenes: [scene(1, 'At the river'), scene(2, 'At the bell')] })
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const annaPages = callsOf('world_page_write').filter((c) => heroOf(c.body) === 'anna');
    expect(annaPages).toHaveLength(2);
    expect(textOf(annaPages[1].body)).toContain('SCENE_OUTSIDE_MENTIONS');
    const step = run.steps.find((s) => s.kind === 'page' && s.key === 'anna');
    expect(step).toMatchObject({ attempt: 2, verdict: 'flags' });
    const scenes = itemOf(run, 'anna', 'scenes');
    expect(scenes.verdict).toBe('flags');
    expect(scenes.remarks.map((r) => r.code)).toContain('SCENE_OUTSIDE_MENTIONS');
    expect(scenes.outcome).toBe('written');
  });

  it('an editor edit in the middle of the run becomes a proposal; «Accept» writes it, content_manager gets 403; the model write takes «read» away', async () => {
    const versionId = await version();
    answer = async (name, body) => {
      // Редактор правит карточку Анны, пока модель пишет её страницу.
      if (
        name === 'world_page_write' &&
        heroOf(body) === 'anna' &&
        !(await entityOf(versionId, 'anna'))
      ) {
        await putEntity(versionId, 'anna', {
          name: 'Anna',
          role: 'main',
          short: 'Editor text.',
        }).expect(200);
        const entity = await entityOf(versionId, 'anna');
        await auth(http().post(`/versions/${versionId}/world/anna/read`))
          .send({ autoTextAt: entity?.autoTextAt?.toISOString() ?? null })
          .expect(200);
      }
      return defaultAnswer(name, body);
    };
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const short = itemOf(run, 'anna', 'short');
    expect(short.outcome).toBe('proposed');
    // Остальные блоки Анны были пусты - записаны сразу.
    expect(itemOf(run, 'anna', 'character').outcome).toBe('written');
    let anna = await entityOf(versionId, 'anna');
    expect(anna?.short).toBe('Editor text.');
    // Запись модели после отметки «прочитано» её снимает: страница скрыта до новой отметки.
    expect(anna?.readAt).not.toBeNull();
    expect(anna!.autoTextAt!.getTime()).toBeGreaterThan(anna!.readAt!.getTime());
    expect(anna?.isListed).toBe(false);

    const proposal = await auth(
      http().get(`/admin/content-drafts/${run.id}/items/${short.index}`),
    ).expect(200);
    expect(proposal.body.text).toBe(page('anna').short);
    await auth(http().post(`/admin/content-drafts/${run.id}/items/${short.index}/accept`), 'cm')
      .send({})
      .expect(403);
    await auth(http().post(`/admin/content-drafts/${run.id}/items/${short.index}/accept`))
      .send({ expectedPrint: proposal.body.print })
      .expect(200);
    anna = await entityOf(versionId, 'anna');
    expect(anna?.short).toBe(page('anna').short);
    expect(itemOf(await runOf(versionId), 'anna', 'short').outcome).toBe('accepted');
  });

  it('name forms the editor saved stay in the run: the model answer does not push them out', async () => {
    const versionId = await version();
    await putEntity(versionId, 'anna', {
      name: 'Anna',
      role: 'main',
      aliases: ['Anna', 'the sister'],
    }).expect(200);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.candidates.find((c) => c.key === 'anna')?.aliases).toEqual(['Anna', 'the sister']);
  });

  it('«Accept» of a proposal whose block the editor changed again - 409 WORLD_BLOCK_CHANGED with the current block; «Discard» leaves the entity as is', async () => {
    const versionId = await version();
    await putEntity(versionId, 'boris', {
      name: 'Boris',
      role: 'main',
      short: 'Editor text.',
    }).expect(200);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const short = itemOf(run, 'boris', 'short');
    expect(short.outcome).toBe('proposed');
    await putEntity(versionId, 'boris', { short: 'Second edit.' }).expect(200);
    const refused = await auth(
      http().post(`/admin/content-drafts/${run.id}/items/${short.index}/accept`),
    )
      .send({})
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'WORLD_BLOCK_CHANGED', current: 'Second edit.' });
    await auth(http().post(`/admin/content-drafts/${run.id}/items/${short.index}/discard`))
      .send({})
      .expect(200);
    expect((await entityOf(versionId, 'boris'))?.short).toBe('Second edit.');
    expect(itemOf(await runOf(versionId), 'boris', 'short').outcome).toBe('discarded');
  });

  // Круг /fix 1 (/qa 17.11.2026): ветки хода и решения по пунктам, которых не было в первом наборе.

  const content = (runId: string, path: string) => `/admin/content-drafts/${runId}${path}`;

  it('«Regenerate»: the page step again with the editor remark, the new text becomes a proposal; name forms are not regenerated; a second regeneration of the block - 409', async () => {
    const versionId = await version();
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    const character = itemOf(run, 'anna', 'character');
    expect(character.outcome).toBe('written');
    const aliases = itemOf(run, 'anna', 'aliases');
    expect(
      (
        await auth(http().post(content(run.id, `/items/${aliases.index}/regenerate`)))
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('WORLD_ITEM_NOT_REGENERABLE');
    answer = (name, body) =>
      name === 'world_page_write' && heroOf(body) === 'anna'
        ? page('anna', { character: 'Anna is restless and brave: she leaves the town in the end.' })
        : defaultAnswer(name, body);
    calls.length = 0;
    await auth(http().post(content(run.id, `/items/${character.index}/regenerate`)))
      .send({ remark: 'Say more about her courage.' })
      .expect(202);
    expect(
      (
        await auth(http().post(content(run.id, `/items/${character.index}/regenerate`)))
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('WORLD_REGEN_IN_PROGRESS');
    await drain();
    const pages = callsOf('world_page_write');
    expect(pages).toHaveLength(1);
    // Перегенерация «character» не дописывает выброшенные цитаты из прочих блоков своего ответа.
    expect((await runOf(versionId)).droppedQuotes).toHaveLength(1);
    expect(textOf(pages[0].body)).toContain('Say more about her courage.');
    run = await runOf(versionId);
    expect(itemOf(run, 'anna', 'character')).toMatchObject({
      outcome: 'proposed',
      regenerating: false,
      regenFailedReason: null,
    });
    // Блок уже был записан ходом: новый текст - предложение, сущность не тронута.
    expect((await entityOf(versionId, 'anna'))?.blocks).toMatchObject({
      character: page('anna').character,
    });
  });

  // /fix 3б (решение арбитра `F08 | F08-4a`): перегенерация одного внешнего блока не дописывает
  // источники, снятые у других блоков её ответа.
  it('«Regenerate» of critique: the dropped sources of the other external blocks of its answer are not added', async () => {
    const versionId = await version();
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    const before = run.droppedSources.length;
    expect(before).toBeGreaterThan(0);
    const critique = itemOf(run, 'anna', 'critique');
    await auth(http().post(content(run.id, `/items/${critique.index}/regenerate`)))
      .send({ remark: 'Name the critic.' })
      .expect(202);
    await drain();
    run = await runOf(versionId);
    expect(run.droppedSources).toHaveLength(before);
    expect(itemOf(run, 'anna', 'critique').regenFailedReason).toBeNull();
  });

  // Решение арбитра `F08 | F08-4a` (delta2): повторная перегенерация с тем же снятым источником
  // не дублирует его в списке хода.
  it('«Regenerate» of critique twice: its own unreachable source is listed once', async () => {
    const versionId = await version();
    // Критика держится на двух источниках: один открылся, второй - нет (снят, блок записан).
    answer = (name, body) =>
      name === 'world_external_write'
        ? { ...EXTERNAL(), critique: { text: 'Critics read her as a rebel.', refs: [0, 1] } }
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    let run = await runOf(versionId);
    const critique = itemOf(run, 'anna', 'critique');
    const count = () =>
      run.droppedSources.filter((d) => d.key === 'anna' && d.host === 'missing.test').length;
    expect(count()).toBe(1);
    for (let i = 0; i < 2; i++) {
      await auth(http().post(content(run.id, `/items/${critique.index}/regenerate`)))
        .send({})
        .expect(202);
      await drain();
    }
    run = await runOf(versionId);
    expect(count()).toBe(1);
  });

  it('«Accept all»: proposals one by one; a block the editor changed again stays a proposal with WORLD_BLOCK_CHANGED in skipped', async () => {
    const versionId = await version();
    await putEntity(versionId, 'boris', {
      name: 'Boris',
      role: 'main',
      short: 'Editor text.',
      character: 'Editor character.',
    }).expect(200);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    const short = itemOf(run, 'boris', 'short');
    const character = itemOf(run, 'boris', 'character');
    expect([short.outcome, character.outcome]).toEqual(['proposed', 'proposed']);
    await putEntity(versionId, 'boris', { short: 'Second edit.' }).expect(200);
    const res = await auth(http().post(content(run.id, '/accept-all')))
      .send({})
      .expect(200);
    expect(res.body.skipped).toEqual([{ index: short.index, code: 'WORLD_BLOCK_CHANGED' }]);
    const after = await runOf(versionId);
    expect(itemOf(after, 'boris', 'short').outcome).toBe('proposed');
    expect(itemOf(after, 'boris', 'character').outcome).toBe('accepted');
    const boris = await entityOf(versionId, 'boris');
    expect(boris?.short).toBe('Second edit.');
    expect((boris?.blocks as { character: string }).character).toBe(page('boris').character);
  });

  it('item refusals: no such item - 400 WORLD_ITEM_UNKNOWN; a written item - 409 WORLD_ITEM_NOT_PROPOSED; a building run - 409 WORLD_WRITE_NOT_READY', async () => {
    const versionId = await version();
    const started = await start(versionId).expect(202);
    expect(
      (
        await auth(http().post(content(started.body.id, '/items/0/accept')))
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('WORLD_WRITE_NOT_READY');
    await drain();
    const run = await runOf(versionId);
    expect(
      (
        await auth(http().post(content(run.id, '/items/999/accept')))
          .send({})
          .expect(400)
      ).body.code,
    ).toBe('WORLD_ITEM_UNKNOWN');
    const written = itemOf(run, 'anna', 'short');
    expect(
      (
        await auth(http().post(content(run.id, `/items/${written.index}/accept`)))
          .send({})
          .expect(409)
      ).body.code,
    ).toBe('WORLD_ITEM_NOT_PROPOSED');
    expect(
      (await auth(http().get(content(run.id, `/items/${written.index}`))).expect(409)).body.code,
    ).toBe('WORLD_ITEM_NOT_PROPOSED');
  });

  it('start refusals: a limit below the dossier built first - 400 DRAFT_LIMIT_TOO_LOW; the spending ceiling - 409 LLM_CEILING_REACHED; a run being built - 409 DRAFT_IN_PROGRESS', async () => {
    const bare = await version({ dossier: false });
    const low = await auth(http().post(base(bare)))
      .send({ limitUsd: 0.000001 })
      .expect(400);
    expect(low.body.code).toBe('DRAFT_LIMIT_TOO_LOW');
    const versionId = await version();
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0 } });
    expect((await start(versionId).expect(409)).body.code).toBe('LLM_CEILING_REACHED');
    await resetBudget();
    await start(versionId).expect(202);
    expect((await start(versionId).expect(409)).body.code).toBe('DRAFT_IN_PROGRESS');
    expect(await prisma.contentDraft.count({ where: { bookVersionId: bare } })).toBe(0);
  });

  it('«Discard run» of a run being built: the operation is cancelled, nothing is written into the world', async () => {
    const versionId = await version();
    const started = await start(versionId).expect(202);
    const res = await auth(http().post(content(started.body.id, '/discard-run')))
      .send({})
      .expect(200);
    expect(res.body.status).toBe('discarded');
    await drain();
    expect(await prisma.bookWorldEntity.count({ where: { bookVersionId: versionId } })).toBe(0);
    expect(callsOf('world_page_write')).toHaveLength(0);
  });

  it('a main character the name forms find in no chapter: the page step fails WORLD_CHARACTER_NOT_FOUND, its external step does not run and no entity is made', async () => {
    const versionId = await version({
      characters: [
        ...ANALYSIS_CHARACTERS,
        { key: 'ghost', name: 'Ghost', role: 'main', description: 'A ghost of the town.' },
      ],
    });
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('ready');
    const ghost = run.steps.filter((s) => s.key === 'ghost');
    expect(ghost.map((s) => [s.kind, s.outcome])).toEqual([
      ['page', 'failed'],
      ['external', 'failed'],
    ]);
    expect(callsOf('world_external_write').filter((c) => heroOf(c.body) === 'Ghost')).toHaveLength(
      0,
    );
    expect(await entityOf(versionId, 'ghost')).toBeNull();
  });

  it('every source of the external step fails on the network of the worker: the operation pauses STEP_FAILED instead of dropping the statements', async () => {
    const versionId = await version();
    answer = (name, body) =>
      name === 'world_external_write'
        ? {
            ...EXTERNAL(),
            sources: [{ title: 'Down', url: `https://down.test:${sourcePort}/page` }],
            prototypes: { text: '', refs: [] },
          }
        : defaultAnswer(name, body);
    await start(versionId).expect(202);
    await drain();
    const run = await runOf(versionId);
    expect(run.status).toBe('building');
    expect(run.operation).toMatchObject({ status: 'paused', pauseReason: 'STEP_FAILED' });
    expect(run.items.some((i) => i.block === 'critique')).toBe(false);
  });

  it('broken run data: the run fails DRAFT_DATA_INVALID instead of repeating a paid step; the analysis lost its main characters after the start - WORLD_ANALYSIS_MISSING', async () => {
    const broken = await version();
    const a = await start(broken).expect(202);
    await prisma.contentDraft.update({ where: { id: a.body.id }, data: { data: { steps: 'x' } } });
    await drain();
    expect(await runOf(broken)).toMatchObject({
      status: 'failed',
      failedReason: 'DRAFT_DATA_INVALID',
    });

    const gone = await version();
    await start(gone).expect(202);
    await prisma.bookAnalysis.update({
      where: { bookVersionId: gone },
      data: { characters: [ANALYSIS_CHARACTERS[2]] },
    });
    await drain();
    expect(await runOf(gone)).toMatchObject({
      status: 'failed',
      failedReason: 'WORLD_ANALYSIS_MISSING',
    });
    expect(callsOf('world_select')).toHaveLength(0);
  });
});
