/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmTaskService } from '../src/modules/llm-worker/llm-task.service';
import { LlmTaskHandlerRegistry } from '../src/modules/llm-worker/llm-task-handler.registry';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { quotePrint } from '../src/modules/translation/analysis-write/analysis-write.steps';
import {
  autostartPairKey,
  ANALYSIS_AUTOSTART_TASK_KIND,
  CONTENT_AUTOSTART_TASK_KIND,
} from '../src/modules/translation/autostart/content-autostart.constants';
import { RunStepSupportService } from '../src/modules/translation/run/run-step-support.service';
import { TranslationDraftService } from '../src/modules/translation/draft/translation-draft.service';
import { MetadataResult } from '../src/modules/translation/metadata/metadata-check';
import { sourceFingerprint } from '../src/modules/translation/source-fingerprint';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F07-3b: автозапуск хода «Write Analysis» по `done` языка запуска перевода (`tech.md` §6, как
 * `F06-5`; решения арбитра `F07 | F07-3`, `F07 | F07-3b`). Язык доводится до `done` тем же вызовом,
 * что шаг запуска (`RunStepSupportService.finishLanguage`), дальше - исполнитель на базе, проходы
 * руками; внешний `fetch` подменён, ответ модели - по имени схемы ответа. Внешний шаг отвечает без
 * источников: фетчер не зовётся, внешние блоки пусты.
 */
describe('Analysis autostart from a translation run (e2e)', () => {
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

  const ANALYSIS_STAGES = [
    'analysis_cast_write',
    'analysis_quotes_write',
    'analysis_meaning_write',
    'analysis_reader_write',
    'analysis_external_write',
    'analysis_review',
  ];
  const SUMMARY_STAGES = [
    'summary_section_write',
    'summary_full_write',
    'summary_brief_write',
    'summary_review',
  ];

  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let support: RunStepSupportService;
  let tasks: LlmTaskService;
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
    options: { languages?: Language[]; writeSummary?: boolean; writeAnalysis?: boolean } = {},
  ) => {
    const languages = options.languages ?? [Language.fr];
    const slug = `f073b-${stamp}-${slugs.length}`;
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

  const autostartOps = (runId: string, contentKind: 'analysis_write' | 'summary_write') =>
    prisma.llmOperation.findMany({
      where: { translationRunId: runId, kind: 'draft', limitUsd: 0, contentKind },
      orderBy: { createdAt: 'asc' },
    });
  const rowsOf = (langId: string, kind: 'analysis_write' | 'summary_write') =>
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
    tasks = app.get(LlmTaskService);
    const email = `f073b-admin-${stamp}@test.com`;
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

  it('both autostart task kinds are registered on the worker: the old image does not claim the analysis one (arbiter F07 | F07-3b, /qa round 1)', () => {
    const kinds = app.get(LlmTaskHandlerRegistry).kinds();
    expect(kinds).toEqual(
      expect.arrayContaining([CONTENT_AUTOSTART_TASK_KIND, ANALYSIS_AUTOSTART_TASK_KIND]),
    );
  });

  it('two languages with Write Analysis: each run starts only after done of its language and writes the analysis; the run, history and report show the Analysis line apart from the translation', async () => {
    const { run, langs, bookId } = await translationRun({ languages: [Language.es, Language.fr] });
    await finish(langs.fr.id);
    // Не раньше `done`: операция и задача заведены, хода ещё нет; у `es` автозапуска нет.
    const [frOp] = await autostartOps(run.id, 'analysis_write');
    expect(frOp).toMatchObject({ status: 'active', createdById: adminId, skipReason: null });
    expect(await rowsOf(langs.fr.id, 'analysis_write')).toHaveLength(0);
    expect(await prisma.llmTask.findFirst({ where: { operationId: frOp.id } })).toMatchObject({
      kind: ANALYSIS_AUTOSTART_TASK_KIND,
      payload: { runLanguageId: langs.fr.id },
      pairKey: autostartPairKey(langs.fr.id, 'analysis_write'),
    });
    expect(await autostartOps(run.id, 'analysis_write')).toHaveLength(1);

    await finish(langs.es.id);
    await drain();
    for (const language of ['es', 'fr'] as const) {
      const [row] = await rowsOf(langs[language].id, 'analysis_write');
      expect(row).toMatchObject({ status: 'ready', language });
      const own = await prisma.llmOperation.findUniqueOrThrow({ where: { id: row.operationId } });
      expect(own).toMatchObject({
        translationRunId: run.id,
        createdById: adminId,
        status: 'done',
        contentKind: 'analysis_write',
      });
      const analysis = await prisma.bookAnalysis.findUniqueOrThrow({
        where: { bookVersionId: langs[language].versionId },
      });
      expect(analysis.mainIdea).toBe(MEANING.mainIdea);
      expect(analysis.hasCore).toBe(true);
      // Пересказ выключен: его хода нет.
      expect(await rowsOf(langs[language].id, 'summary_write')).toHaveLength(0);
    }
    expect(calls.filter((c) => SUMMARY_STAGES.includes(c))).toEqual([]);

    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body).toMatchObject({ writeSummary: false, writeAnalysis: true });
    for (const l of live.body.languages as Array<Record<string, unknown>>) {
      expect(l.summary).toBeNull();
      expect(l.analysis).toMatchObject({
        status: 'ready',
        reason: null,
        operationStatus: 'done',
        stepsDone: 5,
        stepsTotal: 5,
        coreReady: true,
      });
    }
    const history = await auth(http().get(`/admin/books/${bookId}/translation-runs`)).expect(200);
    const item = history.body.items[0] as {
      writeAnalysis: boolean;
      costUsd: string;
      results: Array<{ summary: unknown; analysis: { status: string } }>;
    };
    expect(item.writeAnalysis).toBe(true);
    expect(item.results.map((r) => [r.summary, r.analysis.status])).toEqual([
      [null, 'ready'],
      [null, 'ready'],
    ]);

    const report = await auth(http().get(`/admin/translation-runs/${run.id}/report`)).expect(200);
    // Перевод - без этапов анализа; итог - перевод плюс «Analysis», каждая операция один раз.
    const costs = report.body.costs as Array<{ stage: string; costUsd: string }>;
    expect(costs.filter((c) => ANALYSIS_STAGES.includes(c.stage))).toEqual([]);
    const analysisSpent = (
      report.body.languages as Array<{ summary: unknown; analysis: { spentUsd: string } }>
    ).map((l) => {
      expect(l.summary).toBeNull();
      return Number(l.analysis.spentUsd);
    });
    expect(analysisSpent.every((usd) => usd > 0)).toBe(true);
    const translation = costs.reduce((sum, c) => sum + Number(c.costUsd), 0);
    expect(Number(report.body.totalUsd)).toBeCloseTo(
      translation + analysisSpent.reduce((a, b) => a + b, 0),
      8,
    );
    expect(Number(item.costUsd)).toBeCloseTo(Number(report.body.totalUsd), 8);
  });

  it('the switches are independent (product.md §8 п.12): Summary only - no analysis run, operation or call; both - both runs, each money in its own line', async () => {
    const summaryOnly = await translationRun({ writeSummary: true, writeAnalysis: false });
    await finish(summaryOnly.langs.fr.id);
    await drain();
    expect(await autostartOps(summaryOnly.run.id, 'analysis_write')).toHaveLength(0);
    expect(await rowsOf(summaryOnly.langs.fr.id, 'analysis_write')).toHaveLength(0);
    expect(await rowsOf(summaryOnly.langs.fr.id, 'summary_write')).toHaveLength(1);
    expect(calls.filter((c) => ANALYSIS_STAGES.includes(c))).toEqual([]);
    const summaryLive = await auth(
      http().get(`/admin/translation-runs/${summaryOnly.run.id}`),
    ).expect(200);
    expect(summaryLive.body.writeAnalysis).toBe(false);
    expect(summaryLive.body.languages[0].analysis).toBeNull();
    expect(summaryLive.body.languages[0].summary).toMatchObject({ status: 'ready' });

    const both = await translationRun({ writeSummary: true, writeAnalysis: true });
    await finish(both.langs.fr.id);
    await drain();
    const [summaryRow] = await rowsOf(both.langs.fr.id, 'summary_write');
    const [analysisRow] = await rowsOf(both.langs.fr.id, 'analysis_write');
    expect(summaryRow).toMatchObject({ status: 'ready' });
    expect(analysisRow).toMatchObject({ status: 'ready' });
    const report = await auth(http().get(`/admin/translation-runs/${both.run.id}/report`)).expect(
      200,
    );
    const [lang] = report.body.languages as Array<{
      summary: { spentUsd: string };
      analysis: { spentUsd: string };
    }>;
    const spentOf = async (operationId: string) =>
      Number(
        (await prisma.llmOperation.findUniqueOrThrow({ where: { id: operationId } })).spentUsd,
      );
    // Строка каждого раздела - траты ровно его операций (автозапуск LLM не зовёт, лимит 0).
    expect(Number(lang.summary.spentUsd)).toBeCloseTo(await spentOf(summaryRow.operationId), 8);
    expect(Number(lang.analysis.spentUsd)).toBeCloseTo(await spentOf(analysisRow.operationId), 8);
  });

  it('D9, З: a draft of the editor attached by the run with the editor summary and analysis - after done both runs only propose, the editor text stays', async () => {
    const { run, langs, source } = await translationRun({
      writeSummary: true,
      writeAnalysis: true,
    });
    const fr = langs.fr;
    // Черновик редактора: главы-заготовки без текста, ссылки запуска ещё нет - привязка настоящая.
    await prisma.chapter.updateMany({
      where: { bookVersionId: fr.versionId },
      data: { content: '<p></p>' },
    });
    await prisma.translationRunLanguage.update({
      where: { id: fr.id },
      data: { bookVersionId: null, draftCreatedAt: null },
    });
    await prisma.translationRun.update({
      where: { id: run.id },
      data: { dossierFingerprint: await sourceFingerprint(prisma, source) },
    });
    const lang = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { id: fr.id },
      include: { run: true },
    });
    const metadata = { title: 'T', author: 'A', description: 'D', chapterTitles: [] };
    expect(
      await app.get(TranslationDraftService).openDraft(lang, metadata as unknown as MetadataResult),
    ).toEqual({ kind: 'created', versionId: fr.versionId });
    // Перевод записал главы (за него - текст исходника), редактор заполнил пересказ и анализ.
    for (const c of CHAPTERS) {
      await prisma.chapter.updateMany({
        where: { bookVersionId: fr.versionId, number: c.number },
        data: { content: c.content },
      });
    }
    await auth(http().put(`/versions/${fr.versionId}/summary`))
      .send({ summary: '<p>Editor full.</p>' })
      .expect(200);
    await auth(http().put(`/versions/${fr.versionId}/analysis`))
      .send({ language: 'fr', mainIdea: 'Editor idea.' })
      .expect(200);

    await finish(fr.id);
    await drain();

    const [summaryRow] = await rowsOf(fr.id, 'summary_write');
    const [analysisRow] = await rowsOf(fr.id, 'analysis_write');
    expect(summaryRow).toMatchObject({ status: 'ready' });
    expect(analysisRow).toMatchObject({ status: 'ready' });
    expect(
      (await prisma.bookSummary.findUniqueOrThrow({ where: { bookVersionId: fr.versionId } }))
        .summary,
    ).toBe('<p>Editor full.</p>');
    expect(
      (await prisma.bookAnalysis.findUniqueOrThrow({ where: { bookVersionId: fr.versionId } }))
        .mainIdea,
    ).toBe('Editor idea.');
    const itemsOf = async (kind: string) =>
      (await auth(http().get(`/admin/versions/${fr.versionId}/drafts/${kind}`)).expect(200)).body
        .draft.items as Array<{ target: string; outcome: string }>;
    expect((await itemsOf('summary_write')).find((i) => i.target === 'full')?.outcome).toBe(
      'proposed',
    );
    expect((await itemsOf('analysis_write')).find((i) => i.target === 'mainIdea')?.outcome).toBe(
      'proposed',
    );
  });

  it('a repeat autostart task of the analysis: the language already has its analysis run - closed without a reason, no second run; a content_autostart task (old image too) starts the summary', async () => {
    const { run, langs } = await translationRun();
    await finish(langs.fr.id);
    await drain();
    const [first] = await rowsOf(langs.fr.id, 'analysis_write');
    expect(first.status).toBe('ready');
    const again = async (kind?: 'analysis_write') => {
      const op = await prisma.llmOperation.create({
        data: {
          kind: 'draft',
          limitUsd: 0,
          translationRunId: run.id,
          bookVersionId: langs.fr.versionId,
          contentKind: kind ?? 'summary_write',
        },
      });
      await tasks.enqueue({
        kind: kind ? ANALYSIS_AUTOSTART_TASK_KIND : CONTENT_AUTOSTART_TASK_KIND,
        operationId: op.id,
        bookVersionId: langs.fr.versionId,
        language: 'fr',
        payload: { runLanguageId: langs.fr.id },
        pairKey: autostartPairKey(langs.fr.id, kind ?? 'summary_write'),
      });
      await drain();
      return prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
    };
    expect(await again('analysis_write')).toMatchObject({ status: 'done', skipReason: null });
    expect(await rowsOf(langs.fr.id, 'analysis_write')).toHaveLength(1);
    expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      status: 'ready',
    });

    // Задача `content_autostart` (так же и прежнего образа) - пересказ: ход анализа языка её не закрывает.
    expect(await again()).toMatchObject({ status: 'done', skipReason: null });
    expect(await rowsOf(langs.fr.id, 'summary_write')).toHaveLength(1);
  });

  it.each([
    ['ready', 'done', 'AUTOSTART_SKIPPED_EXISTING'],
    ['building', 'active', 'AUTOSTART_SKIPPED_IN_PROGRESS'],
  ] as const)(
    'a manual analysis run %s at done - %s/%s in the Analysis line, the manual run is kept',
    async (status, opStatus, reason) => {
      const { run, langs } = await translationRun();
      // Ход, начатый на вкладке до `done` языка (ход ручного старта - без ссылки на язык).
      const manualOp = await prisma.llmOperation.create({
        data: { kind: 'draft', limitUsd: 1, status: opStatus, contentKind: 'analysis_write' },
      });
      const manual = await prisma.contentDraft.create({
        data: {
          bookVersionId: langs.fr.versionId,
          kind: 'analysis_write',
          status,
          language: 'fr',
          operationId: manualOp.id,
        },
      });
      await finish(langs.fr.id);
      await drain();
      expect(await rowsOf(langs.fr.id, 'analysis_write')).toHaveLength(0);
      expect(
        await prisma.contentDraft.findUniqueOrThrow({ where: { id: manual.id } }),
      ).toMatchObject({ status });
      const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
      expect(live.body.languages[0].analysis).toMatchObject({
        status: 'skipped',
        reason,
      });
    },
  );
});
