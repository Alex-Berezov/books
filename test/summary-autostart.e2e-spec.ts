/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmTaskService } from '../src/modules/llm-worker/llm-task.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import {
  autostartPairKey,
  CONTENT_AUTOSTART_TASK_KIND,
} from '../src/modules/translation/autostart/content-autostart.constants';
import { RunStepSupportService } from '../src/modules/translation/run/run-step-support.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F06-5: автозапуск хода «Write Summary» по `done` языка запуска перевода (`tech.md` §4; решения
 * арбитра `F06 | F06-5`). Язык доводится до `done` тем же вызовом, что шаг запуска
 * (`RunStepSupportService.finishLanguage`), дальше - исполнитель на базе, проходы руками; внешний
 * `fetch` подменён, ответ модели - по имени схемы ответа.
 */
describe('Summary autostart from a translation run (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const priced = (id: string) => ({
    id,
    name: id,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['structured_outputs'],
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
      {
        key: 'anna',
        source: 'Anna',
        target,
        kind: 'character',
        keepOriginal: false,
        note: '',
      },
    ],
    address: [],
    phrases: [],
  });
  const answerOf = (name: string): unknown =>
    ({
      dossier_part: PART,
      dossier: DOSSIER,
      summary_section_write: { text: 'Anna lives.\n\nShe stays.' },
      summary_full_write: { text: 'Anna lives the whole book.\n\nShe stays to the end.' },
      summary_brief_write: { text: 'Anna lives.\n\nShe stays.' },
      summary_review: { verdict: 'ok', remarks: [] },
    })[name];

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

  const CHAPTERS = [1, 2, 3].map((n) => ({
    number: n,
    title: '',
    content: `<p>Anna in chapter ${n}.</p>`,
  }));

  const drain = async () => {
    for (let i = 0; i < 160; i++) {
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
      chapters?: typeof CHAPTERS;
    } = {},
  ) => {
    const languages = options.languages ?? [Language.fr];
    const slug = `f065-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug);
    const versionOf = (language: Language, chapters: typeof CHAPTERS) =>
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
          chapters: { create: chapters },
        },
      });
    const source = (await versionOf(Language.en, CHAPTERS)).id;
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
        writeSummary: options.writeSummary ?? true,
      },
    });
    await prisma.llmOperation.update({ where: { id: op.id }, data: { translationRunId: run.id } });
    const langs: Record<string, { id: string; versionId: string }> = {};
    for (const language of languages) {
      const versionId = (await versionOf(language, options.chapters ?? CHAPTERS)).id;
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

  const autostartOps = (runId: string) =>
    prisma.llmOperation.findMany({
      where: { translationRunId: runId, kind: 'draft', limitUsd: 0 },
      orderBy: { createdAt: 'asc' },
    });
  const autoRows = (langId: string) =>
    prisma.contentDraft.findMany({ where: { translationRunLanguageId: langId } });
  const SUMMARY_STAGES = [
    'summary_section_write',
    'summary_full_write',
    'summary_brief_write',
    'summary_review',
  ];

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
    const email = `f065-admin-${stamp}@test.com`;
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

  it('two languages: each run starts only after done of its language; the run, history and report show it per language; the summary money is apart from the translation', async () => {
    const { run, operationId, langs, bookId } = await translationRun({
      languages: [Language.es, Language.fr],
    });
    expect(await autostartOps(run.id)).toHaveLength(0);

    await finish(langs.fr.id);
    // Не раньше `done`: операция и задача заведены, хода ещё нет.
    const [frOp] = await autostartOps(run.id);
    expect(frOp).toMatchObject({ status: 'active', createdById: adminId, skipReason: null });
    expect(await autoRows(langs.fr.id)).toHaveLength(0);
    expect(await prisma.llmTask.findFirst({ where: { operationId: frOp.id } })).toMatchObject({
      kind: CONTENT_AUTOSTART_TASK_KIND,
      pairKey: autostartPairKey(langs.fr.id, 'summary_write'),
    });
    // Язык `es` ещё идёт: у него автозапуска нет.
    expect(await autostartOps(run.id)).toHaveLength(1);

    // Последний язык: операция запуска закрывается, своя операция автозапуска - нет.
    await finish(langs.es.id);
    expect(
      (await prisma.llmOperation.findUniqueOrThrow({ where: { id: operationId } })).status,
    ).toBe('done');
    expect((await autostartOps(run.id)).map((o) => o.status)).toEqual(['active', 'active']);

    await drain();
    for (const language of ['es', 'fr'] as const) {
      const [row] = await autoRows(langs[language].id);
      expect(row).toMatchObject({ kind: 'summary_write', status: 'ready', language });
      const own = await prisma.llmOperation.findUniqueOrThrow({ where: { id: row.operationId } });
      expect(own).toMatchObject({ translationRunId: run.id, createdById: adminId, status: 'done' });
      expect(own.limitUsd.gt(0)).toBe(true);
      expect(
        await prisma.bookSummarySection.count({
          where: { bookVersionId: langs[language].versionId },
        }),
      ).toBe(3);
    }
    // Перегенерация текста хода автозапуска - своя операция без `translationRunId` (Р4): её «Continue»
    // и отмена идут в ветку перегенерации, а не автозапуска.
    const [frRow] = await autoRows(langs.fr.id);
    const regen = await auth(http().post(`/admin/content-drafts/${frRow.id}/items/0/regenerate`))
      .send({})
      .expect(202);
    const regenOp = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: (regen.body.items as Array<{ regenOperationId: string }>)[0].regenOperationId },
    });
    expect(regenOp).toMatchObject({ kind: 'draft', translationRunId: null });
    await drain();
    expect((await autostartOps(run.id)).map((o) => [o.status, o.skipReason])).toEqual([
      ['done', null],
      ['done', null],
    ]);

    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.writeSummary).toBe(true);
    // Отметки модели - по вердиктам текстов хода (код-проверки могут отметить и при «ok» проверяющей).
    for (const l of live.body.languages as Array<{
      language: 'es' | 'fr';
      summary: { flaggedTexts: number };
    }>) {
      const [row] = await autoRows(langs[l.language].id);
      const items = (row.data as { items: Array<{ verdict: string }> }).items;
      expect(l.summary.flaggedTexts).toBe(items.filter((i) => i.verdict === 'flags').length);
    }
    for (const l of live.body.languages as Array<{ summary: Record<string, unknown> }>) {
      expect(l.summary).toMatchObject({
        status: 'ready',
        reason: null,
        operationStatus: 'done',
        plannedSections: 3,
        sectionsDone: 3,
        failedTexts: 0,
        fullDone: true,
        briefDone: true,
      });
    }
    const history = await auth(http().get(`/admin/books/${bookId}/translation-runs`)).expect(200);
    const item = history.body.items[0] as {
      writeSummary: boolean;
      costUsd: string;
      results: Array<{ summary: { status: string } }>;
    };
    expect(item.writeSummary).toBe(true);
    expect(item.results.map((r) => r.summary.status)).toEqual(['ready', 'ready']);

    const report = await auth(http().get(`/admin/translation-runs/${run.id}/report`)).expect(200);
    // Перевод - без этапов раздела; итог - перевод плюс «Summary», каждая операция один раз.
    const costs = report.body.costs as Array<{ stage: string; costUsd: string }>;
    expect(costs.filter((c) => SUMMARY_STAGES.includes(c.stage))).toEqual([]);
    const summarySpent = (report.body.languages as Array<{ summary: { spentUsd: string } }>).map(
      (l) => Number(l.summary.spentUsd),
    );
    expect(summarySpent.every((usd) => usd > 0)).toBe(true);
    const translation = costs.reduce((sum, c) => sum + Number(c.costUsd), 0);
    expect(Number(report.body.totalUsd)).toBeCloseTo(
      translation + summarySpent.reduce((a, b) => a + b, 0),
      8,
    );
    expect(Number(item.costUsd)).toBeCloseTo(Number(report.body.totalUsd), 8);
  });

  it('Write Summary off: done of a language writes no run, no operation, no call of the summary stages', async () => {
    const { run, langs } = await translationRun({ writeSummary: false });
    await finish(langs.fr.id);
    await drain();
    expect(
      await prisma.llmOperation.count({ where: { translationRunId: run.id, kind: 'draft' } }),
    ).toBe(0);
    expect(await prisma.contentDraft.count({ where: { bookVersionId: langs.fr.versionId } })).toBe(
      0,
    );
    expect(calls.filter((c) => SUMMARY_STAGES.includes(c))).toEqual([]);
    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.writeSummary).toBe(false);
    expect(live.body.languages[0].summary).toBeNull();
  });

  it('a failed language starts nothing; pause and cancel of the run after done of a language do not stop its run', async () => {
    const { run, langs } = await translationRun({
      languages: [Language.es, Language.fr, Language.pt],
    });
    const failed = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { id: langs.pt.id },
      include: {
        run: { include: { operation: { select: { settingsSnapshot: true, createdById: true } } } },
      },
    });
    await support.failLanguage(failed, 'NO_CHAPTERS_WRITTEN');
    await finish(langs.fr.id);
    // Пауза и отмена - пока операция автозапуска `fr` ещё идёт (задача не исполнена).
    expect((await autostartOps(run.id))[0].status).toBe('active');
    await auth(http().post(`/admin/translation-runs/${run.id}/pause`)).expect(200);
    await auth(http().post(`/admin/translation-runs/${run.id}/cancel`)).expect(200);
    expect((await autostartOps(run.id))[0].status).toBe('active');
    await drain();
    expect(
      (await prisma.translationRunLanguage.findUniqueOrThrow({ where: { id: langs.es.id } }))
        .status,
    ).toBe('cancelled');
    expect((await autoRows(langs.fr.id))[0]).toMatchObject({ status: 'ready' });
    expect(await autoRows(langs.es.id)).toHaveLength(0);
    expect(await autoRows(langs.pt.id)).toHaveLength(0);
    // Одна операция автозапуска - у `fr`.
    expect(await autostartOps(run.id)).toHaveLength(1);
  });

  it('a manual run building at done - AUTOSTART_SKIPPED_IN_PROGRESS in the history, done stays, no failed row; a ready run - AUTOSTART_SKIPPED_EXISTING, the ready run is kept', async () => {
    const building = await translationRun();
    const manualOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'active' },
    });
    await prisma.contentDraft.create({
      data: {
        bookVersionId: building.langs.fr.versionId,
        kind: 'summary_write',
        status: 'building',
        language: 'fr',
        operationId: manualOp.id,
      },
    });
    await finish(building.langs.fr.id);
    await prisma.llmOperation.update({ where: { id: manualOp.id }, data: { status: 'cancelled' } });
    await drain();
    expect(
      (
        await prisma.translationRunLanguage.findUniqueOrThrow({
          where: { id: building.langs.fr.id },
        })
      ).status,
    ).toBe('done');
    expect((await autostartOps(building.run.id))[0]).toMatchObject({
      status: 'done',
      skipReason: 'AUTOSTART_SKIPPED_IN_PROGRESS',
    });
    expect(await autoRows(building.langs.fr.id)).toHaveLength(0);
    const history = await auth(http().get(`/admin/translation-runs/${building.run.id}`)).expect(
      200,
    );
    expect(history.body.languages[0].summary).toMatchObject({
      status: 'skipped',
      reason: 'AUTOSTART_SKIPPED_IN_PROGRESS',
    });

    const ready = await translationRun();
    const readyOp = await prisma.llmOperation.create({
      data: { kind: 'draft', limitUsd: 1, status: 'done' },
    });
    const manual = await prisma.contentDraft.create({
      data: {
        bookVersionId: ready.langs.fr.versionId,
        kind: 'summary_write',
        status: 'ready',
        language: 'fr',
        operationId: readyOp.id,
      },
    });
    await finish(ready.langs.fr.id);
    // Потолок исчерпан: живой ход главнее отказа старта - пропуск EXISTING, а не строка failed.
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    await resetBudget();
    expect(await autoRows(ready.langs.fr.id)).toHaveLength(0);
    expect((await autostartOps(ready.run.id))[0]).toMatchObject({
      skipReason: 'AUTOSTART_SKIPPED_EXISTING',
    });
    expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject(
      {
        status: 'ready',
      },
    );
  });

  it('a repeat content_autostart task: the language already has its run (ready or discarded) - closed without a reason, no second run, the ready run is kept', async () => {
    const { run, langs } = await translationRun();
    await finish(langs.fr.id);
    await drain();
    const [first] = await autoRows(langs.fr.id);
    expect(first.status).toBe('ready');
    const again = async () => {
      const op = await prisma.llmOperation.create({
        data: {
          kind: 'draft',
          limitUsd: 0,
          translationRunId: run.id,
          bookVersionId: langs.fr.versionId,
        },
      });
      await tasks.enqueue({
        kind: CONTENT_AUTOSTART_TASK_KIND,
        operationId: op.id,
        bookVersionId: langs.fr.versionId,
        language: 'fr',
        payload: { runLanguageId: langs.fr.id },
        pairKey: autostartPairKey(langs.fr.id, 'summary_write'),
      });
      await drain();
      return prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
    };
    expect(await again()).toMatchObject({ status: 'done', skipReason: null });
    expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      status: 'ready',
    });

    await prisma.contentDraft.update({ where: { id: first.id }, data: { status: 'discarded' } });
    expect(await again()).toMatchObject({ status: 'done', skipReason: null });
    expect(await autoRows(langs.fr.id)).toHaveLength(1);
    expect(
      await prisma.contentDraft.count({
        where: { bookVersionId: langs.fr.versionId, status: { not: 'discarded' } },
      }),
    ).toBe(0);
  });

  it('the ceiling at the start - a failed row LLM_CEILING_REACHED on the autostart operation, discarded by a manual start; a version without chapter text - SOURCE_HAS_NO_CHAPTERS', async () => {
    const { run, langs } = await translationRun();
    await finish(langs.fr.id);
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0.00001 } });
    await drain();
    const [auto] = await autostartOps(run.id);
    const [row] = await autoRows(langs.fr.id);
    expect(row).toMatchObject({
      status: 'failed',
      failedReason: 'LLM_CEILING_REACHED',
      operationId: auto.id,
    });
    expect(auto).toMatchObject({ status: 'done', skipReason: null });
    const live = await auth(http().get(`/admin/translation-runs/${run.id}`)).expect(200);
    expect(live.body.languages[0].summary).toMatchObject({
      status: 'skipped',
      reason: 'LLM_CEILING_REACHED',
      draftId: row.id,
    });
    await resetBudget();
    await auth(http().post(`/admin/versions/${langs.fr.versionId}/drafts/summary_write`))
      .send({})
      .expect(202);
    expect(await prisma.contentDraft.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'discarded',
    });

    const empty = await translationRun({
      chapters: CHAPTERS.map((c) => ({ ...c, content: '' })),
    });
    await finish(empty.langs.fr.id);
    await drain();
    expect((await autoRows(empty.langs.fr.id))[0]).toMatchObject({
      status: 'failed',
      failedReason: 'SOURCE_HAS_NO_CHAPTERS',
    });
  });

  it('LLM disabled at done - done is written, the autostart is skipped with the reason; disabled after done - skipped by the task the same way', async () => {
    const atDone = await translationRun();
    process.env.OPENROUTER_API_KEY = '';
    await finish(atDone.langs.fr.id);
    expect(
      (await prisma.translationRunLanguage.findUniqueOrThrow({ where: { id: atDone.langs.fr.id } }))
        .status,
    ).toBe('done');
    const [op] = await autostartOps(atDone.run.id);
    expect(op).toMatchObject({ status: 'done', skipReason: 'AUTOSTART_SKIPPED_LLM_DISABLED' });
    expect(await prisma.llmTask.count({ where: { operationId: op.id } })).toBe(0);

    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    const later = await translationRun();
    await finish(later.langs.fr.id);
    process.env.OPENROUTER_API_KEY = '';
    await drain();
    expect((await autostartOps(later.run.id))[0]).toMatchObject({
      status: 'done',
      skipReason: 'AUTOSTART_SKIPPED_LLM_DISABLED',
    });
    expect(await autoRows(later.langs.fr.id)).toHaveLength(0);
  });

  it('the full filled by the editor without a run - the autostart starts, the full of the run is a proposal (Р9)', async () => {
    const { langs } = await translationRun();
    await auth(http().put(`/versions/${langs.fr.versionId}/summary`))
      .send({ summary: '<p>Editor full.</p>' })
      .expect(200);
    await finish(langs.fr.id);
    await drain();
    const [row] = await autoRows(langs.fr.id);
    expect(row.status).toBe('ready');
    const state = await auth(
      http().get(`/admin/versions/${langs.fr.versionId}/drafts/summary_write`),
    ).expect(200);
    expect(state.body.draft.owns.full).toBe(false);
    const full = (state.body.draft.items as Array<{ target: string; outcome: string }>).find(
      (i) => i.target === 'full',
    );
    expect(full?.outcome).toBe('proposed');
    expect(
      (await prisma.bookSummary.findUniqueOrThrow({ where: { bookVersionId: langs.fr.versionId } }))
        .summary,
    ).toBe('<p>Editor full.</p>');
  });
});
