/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, LlmTask, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmTaskService, pairKeyOf } from '../src/modules/llm-worker/llm-task.service';
import { TRANSLATION_RETRY_KIND } from '../src/modules/llm-worker/llm-task.types';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { runTaskInput } from '../src/modules/translation/run/translation-run-tasks.handler';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-4a: шаги запуска перевода по языкам. Ручки старта в этой пачке нет (решение арбитра
 * `F05 | F05-4`): запуск заводится здесь напрямую - операция, строки, задача на язык. Исполнитель
 * настоящий, его проходы зовутся руками (таймер в e2e не заведён, Р25); `fetch` подменён всегда,
 * ответ модели выбирается по имени схемы ответа.
 */
describe('Translation run (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const ALT = 'z/alt-model';
  /** Модель с крошечным контекстом: кусок с досье в неё не влезает. */
  const TINY = 'z/tiny-context';
  /** Модель без цены в каталоге. */
  const NO_PRICE = 'z/no-price';
  const MODELS = {
    data: [
      MODEL,
      ALT,
      TINY,
      NO_PRICE,
      'google/gemma-4-31b-it:free',
      'minimax/minimax-m3.1-flash:free',
    ].map((id) => ({
      id,
      name: id,
      ...(id === TINY ? { context_length: 1_000 } : {}),
      ...(id === NO_PRICE
        ? {}
        : {
            pricing: id.endsWith(':free')
              ? { prompt: '0', completion: '0' }
              : { prompt: '0.000001', completion: '0.000002' },
          }),
      supported_parameters: ['structured_outputs'],
    })),
  };

  const DOSSIER = {
    characters: [
      {
        key: 'anna',
        name: 'Anna',
        variants: ['Annie'],
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
    chapters: [
      { number: 1, title: 'One', summary: 'Arrival.' },
      { number: 2, title: 'Two', summary: 'Stay.' },
    ],
    summaryPlan: [],
    voice: { pace: 'slow', sentenceLength: 'long', lexicon: 'plain', irony: 'none', devices: [] },
    motifs: [],
  };
  const PART = {
    summary: 'S.',
    characters: [],
    entities: [],
    events: [],
    voice: { notes: '', devices: [] },
    motifs: [],
  };
  const GLOSSARY = {
    entries: [
      {
        key: 'anna',
        source: 'Anna',
        target: 'Ana',
        kind: 'character',
        keepOriginal: false,
        note: '',
      },
    ],
    address: [],
    phrases: [],
  };

  interface ChatBody {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { json_schema?: { name?: string } };
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let worker: LlmWorkerService;
  let llm: LlmService;
  let tasks: LlmTaskService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm', string> = { admin: '', cm: '' };
  const stamp = Date.now();
  const slugs: string[] = [];
  const calls: Array<{ name: string; model: string; body: ChatBody }> = [];
  let answer: (name: string, body: ChatBody) => unknown;
  /** Досье в ответе модели: номера глав в нём сверяются с главами исходника. */
  let dossier: typeof DOSSIER;
  /** Ответ перевода с ошибкой провайдера вместо JSON - для отказа всех провайдеров. */
  let refuse: (name: string, body: ChatBody) => Response | null;
  /** Вызов внутри ответа модели: что случилось с базой, пока шёл вызов. */
  let during: (name: string) => Promise<void>;
  /** Стоимость вызова в ответе провайдера, $. */
  let costOf: (name: string) => number;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  /** Язык цели из системного сообщения перевода: `(language code "es")`. */
  const targetOf = (body: ChatBody) =>
    /language code "(\w+)"/.exec(body.messages[0]?.content ?? '')?.[1] ?? '??';

  /** Блоки куска из запроса: `[n] текст` построчно после заголовка. */
  const blocksOf = (body: ChatBody) => {
    const user = body.messages[1]?.content ?? '';
    const list = user.split('Blocks to translate, as "[n] text":\n')[1] ?? '';
    return list
      .split('\n')
      .map((line) => /^\[(\d+)\] (.*)$/s.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ n: Number(m[1]), text: `${targetOf(body).toUpperCase()} ${m[2]}` }));
  };

  const defaultAnswer = (name: string, body: ChatBody): unknown => {
    if (name === 'dossier_part') return PART;
    if (name === 'dossier') return dossier;
    if (name === 'glossary') return GLOSSARY;
    if (name === 'split') {
      const first = /^\[(\d+)\]/m.exec(body.messages[1]?.content ?? '');
      return { boundaryBlock: Number(first?.[1] ?? 0) };
    }
    return {
      blocks: blocksOf(body),
      glossaryFindings: [
        { source: 'Town', target: `Town-${targetOf(body)}`, kind: 'place', note: '' },
      ],
    };
  };

  const translations = () => calls.filter((c) => c.name === 'translation');

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);

  const register = async (email: string) => {
    await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
  };
  const login = async (email: string) =>
    (
      (await http().post('/auth/login').send({ email, password: 'password123' }).expect(200))
        .body as { accessToken: string }
    ).accessToken;

  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  /** Около 4000 слов: два куска со спорным стыком; «Town» во второй половине. */
  const LONG = Array.from(
    { length: 40 },
    (_, i) => `<p>${i < 20 ? 'Anna' : 'Town'} ${i} ${words(99)}</p>`,
  ).join('');
  const SHORT = '<p>Anna arrives.</p><p>— Hello, Annie.</p>';

  const englishBook = async (
    chapters: Array<{ number: number; title: string; content: string }>,
  ) => {
    // Главы досье - ровно главы исходника: иначе сводка досье не по форме.
    dossier = {
      ...DOSSIER,
      chapters: DOSSIER.chapters.filter((c) => chapters.some((x) => x.number === c.number)),
    };
    const slug = `f054-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book } = await createBookWithRights(prisma, slug, {});
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Book en',
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
    return { bookId: book.id, versionId: version.id };
  };

  /** Запуск, как его заведёт старт `F05-4b`: операция, строки и задача на язык. */
  const createRun = async (versionId: string, languages: Language[], limitUsd = '10') => {
    const opData = await llm.operationData({
      kind: 'translation_run',
      bookVersionId: versionId,
      limitUsd: new Prisma.Decimal(limitUsd),
    });
    return prisma.$transaction(async (tx) => {
      const op = await tx.llmOperation.create({ data: opData });
      const run = await tx.translationRun.create({
        data: {
          operationId: op.id,
          bookVersionId: versionId,
          sourceLanguage: 'en',
          languages: { create: languages.map((language) => ({ language })) },
        },
        include: { languages: true },
      });
      await tx.llmOperation.update({ where: { id: op.id }, data: { translationRunId: run.id } });
      for (const l of run.languages) {
        await tasks.enqueue(runTaskInput(l.id, l.language, op.id), tx);
      }
      return { runId: run.id, opId: op.id };
    });
  };

  const langOf = (runId: string, language: Language) =>
    prisma.translationRunLanguage.findUniqueOrThrow({
      where: { runId_language: { runId, language } },
    });
  const opOf = (opId: string) => prisma.llmOperation.findUniqueOrThrow({ where: { id: opId } });

  /** Проходы исполнителя до конца; ожидание `wait` сдвигается в «сейчас», чтобы не ждать таймер. */
  const drain = async (until?: () => Promise<boolean>) => {
    for (let i = 0; i < 120; i++) {
      await prisma.llmTask.updateMany({
        where: { status: 'pending', runAfter: { gt: new Date() } },
        data: { runAfter: new Date(Date.now() - 1000) },
      });
      await worker.runOnce();
      if (until && (await until())) return;
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
    llm = app.get(LlmService);
    tasks = app.get(LlmTaskService);
    const adminEmail = `f054-admin-${stamp}@test.com`;
    const cmEmail = `f054-cm-${stamp}@test.com`;
    await register(adminEmail);
    await register(cmEmail);
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    tokens.admin = await login(adminEmail);
    tokens.cm = await login(cmEmail);
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    answer = defaultAnswer;
    dossier = DOSSIER;
    refuse = () => null;
    during = () => Promise.resolve();
    costOf = () => 0.0001;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (urlOf(url).endsWith('/models')) return json(MODELS);
      if (urlOf(url).endsWith('/chat/completions')) {
        const body = JSON.parse((init as RequestInit).body as string) as ChatBody;
        const name = body.response_format?.json_schema?.name ?? '';
        calls.push({ name, model: body.model, body });
        await during(name);
        const refused = refuse(name, body);
        if (refused) return refused;
        return json({
          model: body.model,
          provider: 'E2EProvider',
          choices: [{ message: { content: JSON.stringify(answer(name, body)) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: costOf(name) },
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

  it('401 without a token, 403 for a content manager on every route', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const routes: Array<['get' | 'post', string]> = [
      ['get', `/admin/translation-runs/${id}`],
      ['post', `/admin/translation-runs/${id}/pause`],
      ['post', `/admin/translation-runs/${id}/resume`],
      ['post', `/admin/translation-runs/${id}/cancel`],
    ];
    for (const [method, path] of routes) {
      await http()[method](path).expect(401);
      await auth(http()[method](path), 'cm').expect(403);
    }
    await auth(http().get(`/admin/translation-runs/${id}`)).expect(404);
  });

  it('two languages: one dossier, a glossary each, pieces in order, findings of piece N in the prompt of N+1, no version', async () => {
    const { bookId, versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);

    await drain();

    expect(calls.filter((c) => c.name === 'dossier')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'glossary')).toHaveLength(2);
    // Спорный стык главы 1 - один вызов `split` на язык: выбор сохранён, повтор его не платит.
    expect(calls.filter((c) => c.name === 'split')).toHaveLength(2);
    expect((await opOf(opId)).status).toBe('done');
    for (const language of ['es', 'fr'] as const) {
      const lang = await langOf(runId, language);
      expect(lang).toMatchObject({ status: 'done', flaggedChunks: 0 });
      const chunks = await prisma.translationChunk.findMany({
        where: { runLanguageId: lang.id },
        orderBy: [{ chapterNumber: 'asc' }, { chunkIndex: 'asc' }],
      });
      expect(chunks.map((c) => [c.chapterNumber, c.chunkIndex])).toEqual([
        [1, 0],
        [1, 1],
        [2, 0],
      ]);
      // Проверок нет (`F05-5`): кусок `done` с пустым вердиктом - «не проверен».
      expect(chunks.every((c) => c.status === 'done' && c.verdict === null)).toBe(true);
      expect(chunks.map((c) => c.costUsd?.toString())).toEqual(['0.0001', '0.0001', '0.0001']);
      expect((chunks[0].blocks as Array<{ text: string }>)[0].text).toMatch(
        new RegExp(`^${language.toUpperCase()} Anna 0`),
      );
      // Переводы языка шли строго по порядку кусков.
      const own = translations().filter((c) => targetOf(c.body) === language);
      expect(own).toHaveLength(3);
      expect(own[0].body.messages[1].content).toContain('[1] Anna 0');
      expect(own[1].body.messages[1].content).toContain('Town 20');
      // Находка куска 1 («Town») - в глоссарии языка до куска 2 и в его промпте.
      expect(own[0].body.messages[1].content).not.toContain(`Town-${language}`);
      expect(own[1].body.messages[1].content).toContain(`Town-${language}`);
      // Хвост предыдущего куска - его перевод.
      expect(own[1].body.messages[1].content).toContain('End of the previous translated piece');
      const glossary = await prisma.bookGlossary.findUniqueOrThrow({
        where: { id: lang.glossaryId as string },
      });
      // В истории - только кусок, который дописал глоссарий («Town»); повтор той же находки
      // в следующих кусках её не пишет.
      const history = glossary.history as Array<{ chunkId: string; entries: unknown[] }>;
      expect(history.map((h) => h.chunkId)).toEqual([chunks[0].id]);
      expect(history[0].entries).toHaveLength(1);
    }
    // Досье и глоссарии строились своими операциями, привязанными к запуску.
    const run = await prisma.translationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.dossierId).not.toBeNull();
    expect(
      await prisma.llmOperation.count({ where: { translationRunId: runId, kind: 'dossier' } }),
    ).toBe(3);
    expect(await prisma.bookVersion.count({ where: { bookId } })).toBe(1);

    const res = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(res.body.operation).toMatchObject({ kind: 'translation_run', status: 'done' });
    expect(res.body.languages[0]).toMatchObject({
      language: 'es',
      status: 'done',
      stage: 'done',
      chapterNumber: 2,
      chapterPosition: 2,
      chaptersTotal: 2,
      chunksDone: 1,
      chunksTotal: 1,
    });
  });

  it('an answer saved before the step is recorded is not paid again', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const translated = async () =>
      (await prisma.translationChunk.count({
        where: { runLanguageId: lang.id, status: 'translated' },
      })) > 0;
    await drain(translated);
    expect(translations()).toHaveLength(1);

    // Исполнитель умер после записи ответа, до итога шага: задача `running` с чужим токеном
    // и истёкшей арендой - её подхватывает следующий захват.
    await prisma.llmTask.updateMany({
      where: {
        operation: { translationRun: { id: runId } },
        status: { in: ['pending', 'running'] },
      },
      data: { status: 'running', ownerToken: 'dead', leaseUntil: new Date(Date.now() - 1000) },
    });
    await drain();

    expect(translations()).toHaveLength(1);
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
  });

  it('an expired lease: the piece is taken over, the first executor does not write it', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    let first = true;
    during = async (name) => {
      if (name !== 'translation' || !first) return;
      first = false;
      // Пока идёт первый вызов, аренду забрал другой исполнитель.
      await prisma.llmTask.updateMany({
        where: { operation: { translationRun: { id: runId } }, status: 'running' },
        data: { ownerToken: 'other', leaseUntil: new Date(Date.now() - 1000) },
      });
    };
    await drain(() => Promise.resolve(translations().length === 1));
    // Первый исполнитель не записал кусок: аренда потеряна до записи.
    const chunk = await prisma.translationChunk.findFirstOrThrow({
      where: { runLanguageId: lang.id },
    });
    expect(chunk.status).toBe('pending');

    await drain();

    expect(translations()).toHaveLength(2);
    const done = await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunk.id } });
    expect(done.status).toBe('done');
    const lastCall = await prisma.llmCall.findFirstOrThrow({
      where: { stage: 'translate', operation: { translationRun: { id: runId } } },
      orderBy: { startedAt: 'desc' },
    });
    expect(done.callId).toBe(lastCall.id);
  });

  it('the limit with four languages pauses without overspending; resume continues all of them and pays no piece twice', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    // Досье и глоссарии готовы заранее: лимит запуска тратится только на перевод.
    const four: Language[] = ['es', 'fr', 'pt', 'ru'];
    const warm = await createRun(versionId, four);
    await drain(
      async () =>
        (await prisma.translationRunLanguage.count({
          where: { runId: warm.runId, glossaryId: { not: null } },
        })) === 4,
    );
    await prisma.llmOperation.update({ where: { id: warm.opId }, data: { status: 'cancelled' } });
    calls.length = 0;

    const limit = '0.05';
    const { runId, opId } = await createRun(versionId, four, limit);
    await drain();

    const paused = await opOf(opId);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
    expect(paused.spentUsd.add(paused.reservedUsd).lte(new Prisma.Decimal(limit))).toBe(true);
    expect(await prisma.llmTask.count({ where: { operationId: opId, status: 'pending' } })).toBe(0);

    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ limitUsd: '10' })
      .expect(200);
    // «Продолжить» ставит задачу на каждый недоделанный язык.
    expect(
      (await prisma.llmTask.findMany({ where: { operationId: opId, status: 'pending' } }))
        .map((t: LlmTask) => t.language)
        .sort(),
    ).toEqual(four);
    await drain();
    expect((await opOf(opId)).status).toBe('done');
    // Каждый кусок оплачен ровно раз: по два куска главы на четыре языка.
    expect(translations()).toHaveLength(8);
  });

  it('the source edited while the run stood on another pause: resume refuses and the pause becomes DOSSIER_STALE', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({
          where: { runLanguageId: lang.id, status: 'done' },
        })) === 1,
    );
    await auth(http().post(`/admin/translation-runs/${runId}/pause`)).expect(200);
    const during = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(during.body.languages[0]).toMatchObject({ stage: 'translate', chunksTotal: 2 });
    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
      data: { content: '<p>Anna leaves.</p>' },
    });
    const before = translations().length;

    const refused = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({})
      .expect(409);

    expect(refused.body).toMatchObject({ code: 'LLM_OPERATION_NOT_RESUMABLE' });
    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    expect(await prisma.llmTask.count({ where: { operationId: opId, status: 'pending' } })).toBe(0);
    expect(translations()).toHaveLength(before);
  });

  it('the chapter edited between split steps pauses DOSSIER_STALE before its pieces are written', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    during = async (name) => {
      if (name !== 'split') return;
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
        data: { content: LONG.replace('Town 39', 'Village 39') },
      });
    };

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    const lang = await langOf(runId, 'es');
    expect(await prisma.translationChunk.count({ where: { runLanguageId: lang.id } })).toBe(0);
    expect(translations()).toHaveLength(0);
  });

  it('a stale ready dossier before the first binding is rebuilt, not a dead end', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const first = await createRun(versionId, ['es']);
    await drain();
    expect((await opOf(first.opId)).status).toBe('done');
    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
      data: { content: '<p>Anna arrives late.</p>' },
    });

    const second = await createRun(versionId, ['es']);
    await drain();

    expect((await opOf(second.opId)).status).toBe('done');
    const run = await prisma.translationRun.findUniqueOrThrow({ where: { id: second.runId } });
    const dossier = await prisma.bookDossier.findUniqueOrThrow({
      where: { id: run.dossierId as string },
    });
    expect(dossier.generation).toBe(2);
  });

  it('a piece in a status the step does not lead is not translated again: the run pauses STEP_FAILED', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({ where: { runLanguageId: lang.id } })) === 1,
    );
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id },
      data: { status: 'checked' },
    });
    const before = translations().length;

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'STEP_FAILED' });
    expect(await langOf(runId, 'es')).toMatchObject({ reason: 'CHUNK_STATUS_UNEXPECTED' });
    expect(translations()).toHaveLength(before);
  });

  it('a stop found while the pause button already stopped the run still sets its reason', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    refuse = (name, body) =>
      name === 'translation' && body.model === MODEL
        ? json(
            { error: { code: 404, message: 'No endpoints found matching your data policy' } },
            404,
          )
        : null;
    during = async (name) => {
      // Редактор нажал «пауза», пока шёл вызов перевода.
      if (name === 'translation') await tasks.pauseOperation(opId, null);
    };

    await drain();

    expect(await opOf(opId)).toMatchObject({
      status: 'paused',
      pauseReason: 'NO_COMPLIANT_PROVIDER',
    });
    expect(await langOf(runId, 'es')).toMatchObject({
      reason: 'LLM_NO_COMPLIANT_PROVIDER',
      reasonModels: [MODEL],
    });
  });

  it('deleting the source version mid-run fails the run operation instead of leaving it active', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { opId } = await createRun(versionId, ['es']);
    await prisma.bookVersion.delete({ where: { id: versionId } });

    await drain();

    expect((await opOf(opId)).status).toBe('failed');
  });

  it('a piece that does not fit the model context is flagged without a call', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    await prisma.llmStageSetting.upsert({
      where: { stage: 'translate' },
      create: { stage: 'translate', model: TINY },
      update: { model: TINY },
    });
    let run: { runId: string; opId: string };
    try {
      run = await createRun(versionId, ['es']);
    } finally {
      await prisma.llmStageSetting.deleteMany({ where: { stage: 'translate' } });
    }

    await drain();

    expect((await opOf(run.opId)).status).toBe('done');
    expect(await langOf(run.runId, 'es')).toMatchObject({ status: 'done', flaggedChunks: 1 });
    const chunk = await prisma.translationChunk.findFirstOrThrow({
      where: { runLanguage: { runId: run.runId } },
    });
    expect(chunk).toMatchObject({ status: 'flagged', flagReason: 'CHUNK_TOO_LONG', attempts: 0 });
    expect(translations()).toHaveLength(0);
  });

  it('the source edited mid-run pauses DOSSIER_STALE', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({
          where: { runLanguageId: lang.id, status: 'done' },
        })) === 1,
    );
    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
      data: { content: '<p>Anna leaves.</p>' },
    });
    const before = translations().length;

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    expect(await langOf(runId, 'es')).toMatchObject({ reason: 'DOSSIER_STALE', chapterNumber: 2 });
    expect(translations()).toHaveLength(before);

    // Продолжать нечего (Р13): выход - отмена или новый запуск; задачи не ставятся.
    const refused = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({})
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'LLM_OPERATION_NOT_RESUMABLE' });
    expect(await prisma.llmTask.count({ where: { operationId: opId, status: 'pending' } })).toBe(0);
    expect((await opOf(opId)).status).toBe('paused');
  });

  it('a chapter edited after its split pauses DOSSIER_STALE before the next piece', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({
          where: { runLanguageId: lang.id, status: 'done' },
        })) === 1,
    );
    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
      data: { content: LONG.replace('Town 39', 'Village 39') },
    });
    const before = translations().length;

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    expect(translations()).toHaveLength(before);
  });

  it('a piece without translatable blocks is closed without a call', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: '<hr>' },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const lang = await langOf(runId, 'es');
    const empty = await prisma.translationChunk.findFirstOrThrow({
      where: { runLanguageId: lang.id, chapterNumber: 2 },
    });
    expect(empty).toMatchObject({ status: 'done', blocks: [], attempts: 0, callId: null });
    expect(translations()).toHaveLength(1);
  });

  it('the run translates on the models of its snapshot, not on a stage setting changed mid-run', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { opId } = await createRun(versionId, ['es']);
    await prisma.llmStageSetting.upsert({
      where: { stage: 'translate' },
      create: { stage: 'translate', model: ALT },
      update: { model: ALT },
    });
    try {
      await drain();
    } finally {
      await prisma.llmStageSetting.deleteMany({ where: { stage: 'translate' } });
    }

    expect((await opOf(opId)).status).toBe('done');
    expect(translations().map((c) => c.model)).toEqual([MODEL]);
  });

  it('every provider refuses: paused NO_COMPLIANT_PROVIDER; resume with stageModels goes on that model', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    refuse = (name, body) =>
      name === 'translation' && body.model === MODEL
        ? json(
            { error: { code: 404, message: 'No endpoints found matching your data policy' } },
            404,
          )
        : null;

    await drain();

    expect(await opOf(opId)).toMatchObject({
      status: 'paused',
      pauseReason: 'NO_COMPLIANT_PROVIDER',
    });
    expect(await langOf(runId, 'es')).toMatchObject({
      reason: 'LLM_NO_COMPLIANT_PROVIDER',
      reasonModels: [MODEL],
    });

    // Отказанное «продолжить» (повтор куска держит язык - отказ уже внутри транзакции, после
    // записи моделей) модели запуска не меняет и задач не ставит.
    const retry = await tasks.enqueue({
      kind: TRANSLATION_RETRY_KIND,
      operationId: opId,
      pairKey: pairKeyOf(opId, 'es'),
    });
    const held = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { translate: ALT } })
      .expect(409);
    expect(held.body).toMatchObject({ code: 'RETRY_IN_PROGRESS' });
    expect((await opOf(opId)).status).toBe('paused');
    if (retry.created) {
      await prisma.llmTask.update({ where: { id: retry.task.id }, data: { status: 'cancelled' } });
    }
    expect(
      (await prisma.translationRun.findUniqueOrThrow({ where: { id: runId } })).stageModels,
    ).toEqual({});

    const noPrice = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { translate: NO_PRICE } })
      .expect(409);
    expect(noPrice.body).toMatchObject({ code: 'LLM_NO_PRICE' });
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { translate: 5 } })
      .expect(400);

    const unknown = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { translate: 'x/nope' } })
      .expect(400);
    expect(unknown.body).toMatchObject({ code: 'LLM_MODEL_UNKNOWN' });
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { split: ALT } })
      .expect(400);
    const resumed = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { translate: ALT } })
      .expect(200);
    expect(resumed.body.stageModels).toEqual({ translate: ALT });
    // «Продолжить» сбрасывает причину остановки языка.
    expect(resumed.body.languages[0]).toMatchObject({ reason: null, reasonModels: [] });

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    expect(translations()[translations().length - 1]?.model).toBe(ALT);
  });

  it('pause and cancel between steps; pause and resume of a finished run are refused', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({
          where: { runLanguageId: lang.id, status: 'done' },
        })) === 1,
    );

    const paused = await auth(http().post(`/admin/translation-runs/${runId}/pause`)).expect(200);
    expect(paused.body.operation).toMatchObject({ status: 'paused', pauseReason: null });
    const before = translations().length;
    await drain();
    expect(translations()).toHaveLength(before);
    await auth(http().post(`/admin/translation-runs/${runId}/pause`)).expect(409);

    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({})
      .expect(200);
    await drain(
      async () =>
        (await prisma.translationChunk.count({ where: { runLanguageId: lang.id } })) === 2,
    );
    const cancelled = await auth(http().post(`/admin/translation-runs/${runId}/cancel`)).expect(
      200,
    );
    expect(cancelled.body.operation.status).toBe('cancelled');
    expect(cancelled.body.languages[0].status).toBe('cancelled');
    await drain();
    expect((await opOf(opId)).status).toBe('cancelled');
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({})
      .expect(409);
    await auth(http().post(`/admin/translation-runs/${runId}/cancel`)).expect(409);
  });

  it('an answer not by the form after two remarks flags the piece; the language goes on', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);
    answer = (name, body) =>
      name === 'translation' && body.messages[1].content.includes('Reader chapter 1')
        ? { blocks: [], glossaryFindings: [] }
        : defaultAnswer(name, body);

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', flaggedChunks: 1 });
    const chunks = await prisma.translationChunk.findMany({
      where: { runLanguageId: lang.id },
      orderBy: { chapterNumber: 'asc' },
    });
    expect(chunks.map((c) => [c.status, c.flagReason])).toEqual([
      ['flagged', 'CHUNK_INVALID_RESPONSE'],
      ['done', null],
    ]);
    // Флаг несёт стоимость всех трёх ответов: первого и двух повторов с замечанием.
    expect(chunks[0].costUsd?.toString()).toBe('0.0003');
    // Первый вызов и два повтора с замечанием, затем флаг.
    expect(
      translations().filter((c) => c.body.messages[1].content.includes('Reader chapter 1')),
    ).toHaveLength(3);
  });

  it('deleting the source version removes the run with its dossier and glossary', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    await drain();
    const run = await prisma.translationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.dossierId).not.toBeNull();
    // Досье под запуском отдельно не удалить (В2): внешний ключ запуска держит его.
    await expect(
      prisma.bookDossier.delete({ where: { id: run.dossierId as string } }),
    ).rejects.toMatchObject({ code: 'P2003' });

    await prisma.bookVersion.delete({ where: { id: versionId } });

    expect(await prisma.translationRun.count({ where: { id: runId } })).toBe(0);
    expect(await prisma.bookDossier.count({ where: { sourceVersionId: versionId } })).toBe(0);
    expect(await opOf(opId)).toMatchObject({ status: 'done' });
  });

  it('the ceiling and the OpenRouter balance pause with their own reasons; the step code stays at the language', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const ceiling = await createRun(versionId, ['es']);
    await drain(
      async () =>
        (await prisma.translationRunLanguage.count({
          where: { runId: ceiling.runId, glossaryId: { not: null } },
        })) === 1,
    );
    const budget = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
    await prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: budget.spentUsd.add(budget.reservedUsd).add('0.000001') },
    });

    await drain();

    expect(await opOf(ceiling.opId)).toMatchObject({
      status: 'paused',
      pauseReason: 'CEILING_REACHED',
    });
    expect(await langOf(ceiling.runId, 'es')).toMatchObject({
      reason: 'LLM_BUDGET_EXCEEDED:ceiling',
    });
    await resetBudget();
    await prisma.llmOperation.update({
      where: { id: ceiling.opId },
      data: { status: 'cancelled' },
    });

    const funds = await createRun(versionId, ['es']);
    refuse = (name) =>
      name === 'translation'
        ? json({ error: { code: 402, message: 'Insufficient credits' } }, 402)
        : null;
    await drain();

    expect(await opOf(funds.opId)).toMatchObject({
      status: 'paused',
      pauseReason: 'INSUFFICIENT_FUNDS',
    });
    expect(await langOf(funds.runId, 'es')).toMatchObject({ reason: 'LLM_INSUFFICIENT_FUNDS' });
  });

  it('a paused dossier builder pauses the run DOSSIER_PAUSED with the builder operation at the language', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    // Первая часть досье стоит больше лимита операции досье: вторая не помещается.
    costOf = (name) => (name === 'dossier_part' ? 50 : 0.0001);
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    const builder = await prisma.llmOperation.findFirstOrThrow({
      where: { translationRunId: runId, kind: 'dossier' },
    });
    expect(builder).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_PAUSED' });
    expect(await langOf(runId, 'es')).toMatchObject({
      reason: 'DOSSIER_PAUSED',
      blockedByOperationId: builder.id,
    });
    const res = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(res.body.languages[0]).toMatchObject({
      stage: 'dossier',
      blockedByOperationId: builder.id,
    });
  });

  it('a step without its language row fails the run; the other languages are failed, not running', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);
    await prisma.translationRunLanguage.delete({
      where: { runId_language: { runId, language: 'fr' } },
    });

    await drain();

    expect((await opOf(opId)).status).toBe('failed');
    const res = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(res.body.languages).toEqual([
      expect.objectContaining({ language: 'es', status: 'failed', stage: 'failed' }),
    ]);
  });
});
