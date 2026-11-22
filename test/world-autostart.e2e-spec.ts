/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmTaskHandlerRegistry } from '../src/modules/llm-worker/llm-task-handler.registry';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { quotePrint } from '../src/modules/translation/analysis-write/analysis-write.steps';
import {
  autostartPairKey,
  ANALYSIS_AUTOSTART_TASK_KIND,
  CONTENT_AUTOSTART_TASK_KIND,
  WORLD_AUTOSTART_TASK_KIND,
  WORLD_AUTOSTART_WAITS_FOR_ANALYSIS,
} from '../src/modules/translation/autostart/content-autostart.constants';
import { RunStepSupportService } from '../src/modules/translation/run/run-step-support.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F08-9b: автозапуск хода «Write World» по `done` языка запуска перевода после хода анализа того же
 * языка (`features/F08-book-wiki/tech.md` §5; решение арбитра `F08 | F08-9b`, Q1-Q6). Обвязка - та же,
 * что у `analysis-autostart.e2e-spec.ts` (`F07-3b`): язык доводится до `done` вызовом шага запуска,
 * дальше - исполнитель на базе, проходы руками; ответ модели - по имени схемы ответа. Ход мира
 * здесь только стартует: его шаги проверяет `world-write.e2e-spec.ts`, поэтому проходы исполнителя
 * идут до появления строки хода мира, а не до конца очереди.
 */
describe('World autostart from a translation run (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const priced = (id: string) => ({
    id,
    name: id,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['structured_outputs'],
    context_length: 400_000,
  });
  const MODELS = {
    data: [
      'anthropic/claude-sonnet-5.5',
      'z-ai/glm-5.3',
      'qwen/qwen3.7-plus',
      'openai/gpt-5.6-terra',
      'openai/gpt-6-luna',
      'anthropic/claude-haiku-5.5',
      'deepseek/deepseek-v4-pro',
    ].map(priced),
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
  const glossaryOf = (target: string) => ({
    entries: [
      { key: 'anna', source: 'Anna', target, kind: 'character', keepOriginal: false, note: '' },
    ],
    address: [],
    phrases: [],
  });

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
  /** Внешний шаг без источников: утверждений нет - внешние блоки пусты, фетчер не зовётся. */
  const EXTERNAL = {
    genre: '',
    genreRefs: [],
    movement: '',
    movementRefs: [],
    writtenYears: '',
    writtenYearsRefs: [],
    context: [],
    timeline: [],
    reception: [],
    adaptations: [],
    sources: [],
  };
  const answerOf = (name: string): unknown =>
    ({
      dossier_part: PART,
      dossier: DOSSIER,
      analysis_cast_write: CAST,
      analysis_quotes_write: QUOTES,
      analysis_meaning_write: MEANING,
      analysis_reader_write: READER,
      analysis_external_write: EXTERNAL,
      analysis_review: { verdict: 'ok', remarks: [] },
      summary_section_write: { text: 'Anna lives.\n\nShe stays.' },
      summary_full_write: { text: 'Anna lives the whole book.\n\nShe stays to the end.' },
      summary_brief_write: { text: 'Anna lives.\n\nShe stays.' },
      summary_review: { verdict: 'ok', remarks: [] },
    })[name];

  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let support: RunStepSupportService;
  let fetchSpy: jest.SpyInstance;
  let token = '';
  let adminId = '';
  const stamp = Date.now();
  const slugs: string[] = [];
  const calls: string[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  const drain = async () => {
    for (let i = 0; i < 200; i++) {
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

  const resetBudget = () =>
    prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0, defaultRunLimitUsd: 10 },
    });

  /**
   * Исходник `en` с готовым досье, переведённые версии языков и запуск перевода с готовыми досье
   * и глоссариями, языки - `running` (как перед последним шагом). Автор запуска - админ.
   */
  const translationRun = async (
    options: {
      languages?: Language[];
      writeSummary?: boolean;
      writeAnalysis?: boolean;
      writeWorld?: boolean;
    } = {},
  ) => {
    const languages = options.languages ?? [Language.fr];
    const slug = `f089b-${stamp}-${slugs.length}`;
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
    await auth(http().post(`/admin/versions/${source}/dossier`))
      .send({})
      .expect(202);
    await drain();
    const dossier = await prisma.bookDossier.findFirstOrThrow({
      where: { sourceVersionId: source, status: 'ready' },
    });
    const op = await prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: 1, status: 'active', createdById: adminId },
    });
    const run = await prisma.translationRun.create({
      data: {
        operationId: op.id,
        bookVersionId: source,
        sourceLanguage: 'en',
        dossierId: dossier.id,
        writeSummary: options.writeSummary ?? false,
        writeAnalysis: options.writeAnalysis ?? true,
        writeWorld: options.writeWorld ?? true,
      },
    });
    await prisma.llmOperation.update({ where: { id: op.id }, data: { translationRunId: run.id } });
    const langs: Record<string, { id: string; versionId: string }> = {};
    for (const language of languages) {
      const versionId = (await versionOf(language)).id;
      const glossary = await prisma.bookGlossary.create({
        data: {
          dossierId: dossier.id,
          language,
          status: 'ready',
          data: glossaryOf(`Anna-${language}`),
        },
      });
      const lang = await prisma.translationRunLanguage.create({
        data: {
          runId: run.id,
          language,
          glossaryId: glossary.id,
          status: 'running',
          bookVersionId: versionId,
          draftCreatedAt: new Date(),
        },
      });
      langs[language] = { id: lang.id, versionId };
    }
    calls.length = 0;
    return { run, operationId: op.id, langs, source, bookId: book.id };
  };

  /** Язык доведён до `done` тем же вызовом, что последний шаг запуска. */
  const finish = async (langId: string) => {
    const lang = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { id: langId },
      include: {
        run: { include: { operation: { select: { settingsSnapshot: true, createdById: true } } } },
      },
    });
    await support.finishLanguage(lang);
  };

  type SectionKind = 'analysis_write' | 'summary_write' | 'world_write';
  const autostartOps = (runId: string, contentKind: SectionKind) =>
    prisma.llmOperation.findMany({
      where: { translationRunId: runId, kind: 'draft', limitUsd: 0, contentKind },
      orderBy: { createdAt: 'asc' },
    });
  const rowsOf = (langId: string, kind: SectionKind) =>
    prisma.contentDraft.findMany({ where: { translationRunLanguageId: langId, kind } });

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
    support = app.get(RunStepSupportService);
    const email = `f089b-admin-${stamp}@test.com`;
    await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
    await grantStaffRoles(app, email);
    const res = await http()
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);
    token = (res.body as { accessToken: string }).accessToken;
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
      if (urlOf(url).endsWith('/models')) return Promise.resolve(json(MODELS));
      if (urlOf(url).endsWith('/chat/completions')) {
        const body = JSON.parse((init as RequestInit).body as string) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          response_format?: { json_schema?: { name?: string } };
        };
        const name = llmCallName(body);
        calls.push(name);
        return Promise.resolve(
          json({
            model: body.model,
            provider: 'E2EProvider',
            choices: [{ message: { content: JSON.stringify(answerOf(name)) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${urlOf(url)}`));
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

  /**
   * Проходы исполнителя, пока у языка не появится строка хода мира: на каждом проходе - что видит
   * задача автозапуска мира и в каком состоянии ход анализа языка.
   */
  const runUntilWorld = async (langId: string) => {
    const seen: Array<{ analysis: string | null; worldTask: string | null }> = [];
    for (let i = 0; i < 200; i++) {
      await prisma.llmTask.updateMany({
        where: { status: 'pending', runAfter: { gt: new Date() } },
        data: { runAfter: new Date(Date.now() - 1000) },
      });
      await worker.runOnce();
      const [analysis] = await rowsOf(langId, 'analysis_write');
      const worldTask = await prisma.llmTask.findFirst({
        where: { kind: WORLD_AUTOSTART_TASK_KIND, payload: { equals: { runLanguageId: langId } } },
      });
      seen.push({ analysis: analysis?.status ?? null, worldTask: worldTask?.lastError ?? null });
      const [world] = await rowsOf(langId, 'world_write');
      if (world) return { world, seen };
    }
    throw new Error('the world run did not start');
  };

  it('the world autostart task kind is registered on the worker: the old image does not claim it (arbiter F08 | F08-9b, as F07 | F07-3b)', () => {
    const kinds = app.get(LlmTaskHandlerRegistry).kinds();
    expect(kinds).toEqual(
      expect.arrayContaining([
        CONTENT_AUTOSTART_TASK_KIND,
        ANALYSIS_AUTOSTART_TASK_KIND,
        WORLD_AUTOSTART_TASK_KIND,
      ]),
    );
  });

  it('Write World off: done of the language starts the analysis only - no world operation, task or run; the World line is null', async () => {
    const { run, langs } = await translationRun({ writeWorld: false });
    await finish(langs.fr.id);
    await drain();
    expect(await autostartOps(run.id, 'world_write')).toHaveLength(0);
    expect(
      await prisma.llmTask.count({
        where: { kind: WORLD_AUTOSTART_TASK_KIND, operation: { translationRunId: run.id } },
      }),
    ).toBe(0);
    const [analysis] = await rowsOf(langs.fr.id, 'analysis_write');
    expect(analysis).toMatchObject({ status: 'ready' });
    expect(await rowsOf(langs.fr.id, 'world_write')).toHaveLength(0);
    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body).toMatchObject({ writeAnalysis: true, writeWorld: false });
    expect(live.body.languages[0].world).toBeNull();
  });

  it('Write World on: the world task waits while the analysis run of the language is being built, then starts the world run linked to the language and the run; the run, history and report show the World line', async () => {
    const { run, langs, bookId } = await translationRun({ writeWorld: true });
    await finish(langs.fr.id);
    // По `done`: операции и задачи анализа и мира заведены вместе, хода мира нет.
    const [worldOp] = await autostartOps(run.id, 'world_write');
    expect(worldOp).toMatchObject({ status: 'active', createdById: adminId, skipReason: null });
    expect(await prisma.llmTask.findFirst({ where: { operationId: worldOp.id } })).toMatchObject({
      kind: WORLD_AUTOSTART_TASK_KIND,
      payload: { runLanguageId: langs.fr.id },
      pairKey: autostartPairKey(langs.fr.id, 'world_write'),
    });
    const pending = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(pending.body).toMatchObject({ writeAnalysis: true, writeWorld: true });
    expect(pending.body.languages[0].world).toMatchObject({ status: 'pending', reason: null });

    const { world, seen } = await runUntilWorld(langs.fr.id);
    // Пока ход анализа строился, задача мира ждала с причиной, а не стартовала и не падала.
    expect(seen.some((s) => s.worldTask === WORLD_AUTOSTART_WAITS_FOR_ANALYSIS)).toBe(true);
    // Ход мира стартовал только после готового анализа языка.
    const [analysis] = await rowsOf(langs.fr.id, 'analysis_write');
    expect(analysis.status).toBe('ready');
    expect(world.createdAt.getTime()).toBeGreaterThanOrEqual(analysis.updatedAt.getTime());
    expect(world).toMatchObject({ language: 'fr', bookVersionId: langs.fr.versionId });
    const own = await prisma.llmOperation.findUniqueOrThrow({ where: { id: world.operationId } });
    expect(own).toMatchObject({
      translationRunId: run.id,
      createdById: adminId,
      contentKind: 'world_write',
    });
    // Операция автозапуска мира закрыта без причины: ход есть.
    expect(
      await prisma.llmOperation.findUniqueOrThrow({ where: { id: worldOp.id } }),
    ).toMatchObject({
      status: 'done',
      skipReason: null,
    });

    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.languages[0].world).toMatchObject({ draftId: world.id });
    const history = await auth(http().get(`/admin/books/${bookId}/translation-runs`)).expect(200);
    const item = history.body.items[0] as {
      writeWorld: boolean;
      results: Array<{ world: { draftId: string } | null }>;
    };
    expect(item.writeWorld).toBe(true);
    expect(item.results[0].world).toMatchObject({ draftId: world.id });
    const report = await auth(http().get(`/admin/translation-runs/${run.id}/report`)).expect(200);
    expect(report.body.languages[0].world).toMatchObject({ draftId: world.id });

    // Траты хода мира - в строке World отчёта, а не в остатке без строки: остаток не растёт.
    await prisma.llmOperation.update({ where: { id: world.operationId }, data: { spentUsd: 0.5 } });
    const spent = await auth(http().get(`/admin/translation-runs/${run.id}/report`)).expect(200);
    expect(Number(spent.body.languages[0].world.spentUsd)).toBeCloseTo(0.5, 8);
    expect(Number(spent.body.totalUsd)).toBeCloseTo(Number(report.body.totalUsd) + 0.5, 8);
    expect(spent.body.breakdown.unattributedUsd).toBe(report.body.breakdown.unattributedUsd);
  });

  it('the analysis run of the language is not ready (failed): the world run does not start - the World line is not started with WORLD_ANALYSIS_MISSING', async () => {
    const { run, langs } = await translationRun({ writeWorld: true });
    await finish(langs.fr.id);
    // Ход анализа языка кончился не `ready`: отказ его автозапуска строкой `failed` (Р6).
    const [analysisOp] = await autostartOps(run.id, 'analysis_write');
    await prisma.llmTask.updateMany({
      where: { operationId: analysisOp.id },
      data: { status: 'cancelled' },
    });
    await prisma.contentDraft.create({
      data: {
        bookVersionId: langs.fr.versionId,
        kind: 'analysis_write',
        status: 'failed',
        failedReason: 'LLM_CEILING_REACHED',
        language: 'fr',
        operationId: analysisOp.id,
        translationRunLanguageId: langs.fr.id,
      },
    });
    await prisma.llmOperation.update({ where: { id: analysisOp.id }, data: { status: 'done' } });
    await drain();
    const [world] = await rowsOf(langs.fr.id, 'world_write');
    expect(world).toMatchObject({ status: 'failed', failedReason: 'WORLD_ANALYSIS_MISSING' });
    expect(calls.filter((c) => c.startsWith('world_'))).toEqual([]);
    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.languages[0].world).toMatchObject({
      status: 'skipped',
      reason: 'WORLD_ANALYSIS_MISSING',
    });
  });

  it('a manual world run ready on the version at done: the autostart does not start a second one and keeps the editor run (AUTOSTART_SKIPPED_EXISTING)', async () => {
    const { run, langs } = await translationRun({ writeWorld: true });
    // Ход мира, начатый на вкладке до `done` языка (ручной старт - без ссылки на язык).
    const manualOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'done', contentKind: 'world_write' },
    });
    const manual = await prisma.contentDraft.create({
      data: {
        bookVersionId: langs.fr.versionId,
        kind: 'world_write',
        status: 'ready',
        language: 'fr',
        operationId: manualOp.id,
      },
    });
    await finish(langs.fr.id);
    await drain();
    // Ход анализа запуска готов, ход мира не заводился: ручной не отброшен, второго нет.
    const [analysis] = await rowsOf(langs.fr.id, 'analysis_write');
    expect(analysis).toMatchObject({ status: 'ready' });
    expect(await rowsOf(langs.fr.id, 'world_write')).toHaveLength(0);
    expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject(
      { status: 'ready' },
    );
    expect(
      await prisma.contentDraft.count({
        where: { bookVersionId: langs.fr.versionId, kind: 'world_write' },
      }),
    ).toBe(1);
    expect(calls.filter((c) => c.startsWith('world_'))).toEqual([]);
    const [worldOp] = await autostartOps(run.id, 'world_write');
    expect(worldOp).toMatchObject({ status: 'done', skipReason: 'AUTOSTART_SKIPPED_EXISTING' });
    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.languages[0].world).toMatchObject({
      status: 'skipped',
      reason: 'AUTOSTART_SKIPPED_EXISTING',
    });
  });

  it('a manual analysis run of the version (the analysis autostart is skipped): the world waits while it is being built and starts once it is ready', async () => {
    const { run, langs } = await translationRun({ writeWorld: true });
    // Ход анализа, начатый на вкладке до `done` языка: автозапуск анализа закроется пропуском.
    const manualOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'active', contentKind: 'analysis_write' },
    });
    const manual = await prisma.contentDraft.create({
      data: {
        bookVersionId: langs.fr.versionId,
        kind: 'analysis_write',
        status: 'building',
        language: 'fr',
        operationId: manualOp.id,
      },
    });
    await finish(langs.fr.id);
    for (let i = 0; i < 3; i++) {
      await prisma.llmTask.updateMany({
        where: { status: 'pending', runAfter: { gt: new Date() } },
        data: { runAfter: new Date(Date.now() - 1000) },
      });
      await worker.runOnce();
    }
    const [analysisOp] = await autostartOps(run.id, 'analysis_write');
    expect(analysisOp).toMatchObject({ skipReason: 'AUTOSTART_SKIPPED_IN_PROGRESS' });
    // Ручной ход анализа версии строится - мир ждёт, а не пишет «нет анализа».
    expect(await rowsOf(langs.fr.id, 'world_write')).toHaveLength(0);
    const waiting = await prisma.llmTask.findFirstOrThrow({
      where: {
        kind: WORLD_AUTOSTART_TASK_KIND,
        payload: { equals: { runLanguageId: langs.fr.id } },
      },
    });
    expect(waiting).toMatchObject({
      status: 'pending',
      lastError: WORLD_AUTOSTART_WAITS_FOR_ANALYSIS,
    });

    // Редактор довёл анализ: у версии есть герой `main`, ход анализа готов.
    await auth(http().put(`/versions/${langs.fr.versionId}/analysis`))
      .send({
        language: 'fr',
        characters: CAST.characters.map(({ key, name, role, description }) => ({
          key,
          name,
          role,
          description,
        })),
      })
      .expect(200);
    await prisma.contentDraft.update({ where: { id: manual.id }, data: { status: 'ready' } });
    await prisma.llmOperation.update({ where: { id: manualOp.id }, data: { status: 'done' } });

    const { world } = await runUntilWorld(langs.fr.id);
    expect(world).toMatchObject({ language: 'fr', bookVersionId: langs.fr.versionId });
    expect(world.status).not.toBe('failed');
    const own = await prisma.llmOperation.findUniqueOrThrow({ where: { id: world.operationId } });
    expect(own).toMatchObject({ translationRunId: run.id, contentKind: 'world_write' });
  });

  it('a manual world run ready on the version and the analysis run of the language failed: the live world run wins - skipped as existing, no second world row (arbiter F08 | F08-9b-1, 2)', async () => {
    const { run, langs } = await translationRun({ writeWorld: true });
    const worldOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'done', contentKind: 'world_write' },
    });
    const manual = await prisma.contentDraft.create({
      data: {
        bookVersionId: langs.fr.versionId,
        kind: 'world_write',
        status: 'ready',
        language: 'fr',
        operationId: worldOp.id,
      },
    });
    await finish(langs.fr.id);
    // Ход анализа языка кончился не `ready` (как в тесте выше).
    const [analysisOp] = await autostartOps(run.id, 'analysis_write');
    await prisma.llmTask.updateMany({
      where: { operationId: analysisOp.id },
      data: { status: 'cancelled' },
    });
    await prisma.contentDraft.create({
      data: {
        bookVersionId: langs.fr.versionId,
        kind: 'analysis_write',
        status: 'failed',
        failedReason: 'LLM_CEILING_REACHED',
        language: 'fr',
        operationId: analysisOp.id,
        translationRunLanguageId: langs.fr.id,
      },
    });
    await prisma.llmOperation.update({ where: { id: analysisOp.id }, data: { status: 'done' } });
    await drain();
    expect(
      await prisma.contentDraft.findMany({
        where: { bookVersionId: langs.fr.versionId, kind: 'world_write' },
        select: { id: true, status: true },
      }),
    ).toEqual([{ id: manual.id, status: 'ready' }]);
    const [autostart] = await autostartOps(run.id, 'world_write');
    expect(autostart).toMatchObject({ status: 'done', skipReason: 'AUTOSTART_SKIPPED_EXISTING' });
    const latest = await auth(
      http().get(`/admin/versions/${langs.fr.versionId}/drafts/world_write`),
    ).expect(200);
    expect(latest.body.draft).toMatchObject({ id: manual.id, status: 'ready' });
    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.languages[0].world).toMatchObject({
      status: 'skipped',
      reason: 'AUTOSTART_SKIPPED_EXISTING',
    });
  });
});
