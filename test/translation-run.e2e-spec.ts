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
import { LlmOperationsService } from '../src/modules/llm-worker/llm-operations.service';
import { lockBookLanguages } from '../src/modules/book-version/book-language-lock';
import {
  ContextEstimates,
  DossierService,
} from '../src/modules/translation/dossier/dossier.service';
import { runTaskInput } from '../src/modules/translation/run/translation-run.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-4a: шаги запуска перевода по языкам - запуск заводится напрямую (`createRun`): операция,
 * строки, задача на язык. F05-4b: оценка, старт ручкой, замок языка, запуски книги. Исполнитель
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
  /** Умолчания сверки смысла: другое семейство, чем модель перевода. */
  const CHECKER = 'deepseek/deepseek-v4-pro';
  const CHECKER_ALT = 'z-ai/glm-5.3';
  /** Jev: цена динамическая, в каталоге без цены (Р24). */
  const JEV = 'typesafe/jev-router';
  /** Проверяющий того же семейства, что запасная перевода `ALT`. */
  const Z_CHECKER = 'z/checker';
  const MODELS = {
    data: [
      MODEL,
      ALT,
      TINY,
      NO_PRICE,
      CHECKER,
      CHECKER_ALT,
      JEV,
      Z_CHECKER,
      'google/gemma-4-31b-it:free',
      'minimax/minimax-m3.1-flash:free',
    ].map((id) => ({
      id,
      name: id,
      ...(id === TINY ? { context_length: 1_000 } : {}),
      ...(id === NO_PRICE || id === JEV
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

  /** Язык цели запуска для Jev: проверяющий в тесте отвечает языком текста «перевода». */
  let jevTargetOf: (body: ChatBody) => string;

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

  /**
   * Ответ этапа `metadata` (`F05-6`): поля из запроса с меткой языка - название, автор, блоки
   * описания и названия глав по номерам; пустое название главы остаётся пустым.
   */
  const metadataAnswerOf = (body: ChatBody) => {
    const user = body.messages[1]?.content ?? '';
    const tag = targetOf(body).toUpperCase();
    const field = (label: string) => new RegExp(`^${label}: (.*)$`, 'm').exec(user)?.[1] ?? '';
    const listed = (header: string, end: string) =>
      (user.split(header)[1] ?? '')
        .split(end)[0]
        .split('\n')
        .map((line) => /^\[(\d+)\] ?(.*)$/s.exec(line))
        .filter((m): m is RegExpExecArray => m !== null);
    return {
      title: `${tag} ${field('Title')}`,
      author: `${tag} ${field('Author')}`,
      description: listed('Description blocks, as "[n] text":\n', '\n\nChapter titles').map(
        (m) => ({ n: Number(m[1]), text: `${tag} ${m[2]}` }),
      ),
      chapterTitles: listed('Chapter titles, as "[number] title":\n', '\nDATA>>>').map((m) => ({
        number: Number(m[1]),
        title: m[2] === '' ? '' : `${tag} ${m[2]}`,
      })),
    };
  };

  const defaultAnswer = (name: string, body: ChatBody): unknown => {
    if (name === 'metadata') return metadataAnswerOf(body);
    if (name === 'dossier_part') return PART;
    if (name === 'dossier') return dossier;
    if (name === 'glossary') return GLOSSARY;
    if (name === 'check_semantic') {
      return { verdict: 'pass', samples: [], omissions: [], nameFlags: [], remarks: [] };
    }
    if (name === 'check_language_jev') return { language: jevTargetOf(body) };
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

  /** Запуск в обход ручки старта: то же, что пишет `TranslationRunService.start`, без проверок. */
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
    // Предел проходов с запасом: тест на четыре языка (досье, четыре глоссария, нарезка и
    // находки на каждый кусок) берёт локально 107 проходов при двух слотах по умолчанию и 68
    // при одном (замер 22.10.2026, дело F05-4a). При 120 медленный CI не уложился (ci.yml
    // 39832636974): проход, совпавший с захватом фонового таймера, возвращается пустым.
    for (let i = 0; i < 600; i++) {
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
    jevTargetOf = () => 'es';
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
      ['get', `/admin/versions/${id}/translation-runs/estimate?languages=es`],
      ['post', `/admin/versions/${id}/translation-runs`],
      ['get', `/admin/books/${id}/translation-runs`],
    ];
    for (const [method, path] of routes) {
      await http()[method](path).expect(401);
      await auth(http()[method](path), 'cm').expect(403);
    }
    await auth(http().get(`/admin/translation-runs/${id}`)).expect(404);
  });

  it('two languages: one dossier, a glossary each, pieces in order, findings of piece N in the prompt of N+1, chapters assembled, version fields translated, no version yet', async () => {
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
      // Кусок проверен (`F05-5`): механика прошла, Jev выключен, смысл - моделью другого
      // семейства; стоимость куска - перевод плюс сверка смысла.
      expect(chunks.every((c) => c.status === 'done')).toBe(true);
      for (const c of chunks) {
        expect(c.verdict).toMatchObject({
          failures: 0,
          remarks: [],
          attempts: [
            {
              translatedBy: MODEL,
              outcome: 'pass',
              jev: { kind: 'disabled' },
              semantic: { model: CHECKER },
              mechanical: { failures: [] },
            },
          ],
        });
      }
      expect(chunks.map((c) => c.costUsd?.toString())).toEqual(['0.0002', '0.0002', '0.0002']);
      // Jev выключен по умолчанию - не зовётся, механика кодом работает.
      expect(calls.filter((c) => c.name === 'check_language_jev')).toHaveLength(0);
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
    // Черновик версии - подпачка 6b (решение арбитра `F05 | F05-6`): здесь главы собраны,
    // поля версии переведены, версии нет.
    expect(await prisma.bookVersion.count({ where: { bookId } })).toBe(1);
    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(2);
    for (const language of ['es', 'fr'] as const) {
      const lang = await langOf(runId, language);
      expect(lang).toMatchObject({ flaggedChapters: 0, bookVersionId: null });
      const chapters = await prisma.translationChapter.findMany({
        where: { runLanguageId: lang.id },
        orderBy: { chapterNumber: 'asc' },
      });
      expect(chapters.map((c) => [c.chapterNumber, c.status, c.flagReason, c.lengthLimit])).toEqual(
        [
          [1, 'assembled', null, 500_000],
          [2, 'assembled', null, 500_000],
        ],
      );
      const tag = language.toUpperCase();
      expect(chapters[1].length).toBe(
        `<p>${tag} Anna arrives.</p><p>${tag} — Hello, Annie.</p>`.length,
      );
      expect(lang.metadata).toMatchObject({
        attempts: [{ model: MODEL, outcome: 'pass', remarks: [] }],
        result: {
          title: `${tag} Book en`,
          author: `${tag} Author`,
          authorFromGlossary: false,
          description: `${tag} Desc`,
          chapterTitles: [
            { number: 1, title: `${tag} One` },
            { number: 2, title: `${tag} Two` },
          ],
        },
      });
    }

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

    // Перевод по 0,01 при резерве вызова около 0,035: лимит 0,05 достигается и одновременными
    // резервами двух слотов, и последовательными вызовами одного - после одного-двух оплаченных
    // кусков. Иначе при последовательных вызовах факт по 0,0001 лимита не достигал бы вовсе.
    costOf = (name) => (name === 'translation' ? 0.01 : 0.0001);
    const limit = '0.05';
    const { runId, opId } = await createRun(versionId, four, limit);
    await drain();

    const paused = await opOf(opId);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
    expect(paused.spentUsd.add(paused.reservedUsd).lte(new Prisma.Decimal(limit))).toBe(true);
    // Пауза пришла после оплаченных кусков, а не на первом резерве.
    expect(translations().length).toBeGreaterThan(0);
    expect(translations().length).toBeLessThan(8);
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

  it('a checked piece is closed by its findings, not translated or checked again', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({
          where: { runLanguageId: lang.id, status: 'checked' },
        })) === 1,
    );
    const before = calls.length;
    // Кусок проверен и ждёт находок - этап «проверка».
    const checking = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(checking.body.languages[0]).toMatchObject({ stage: 'check' });

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const [chunk] = await prisma.translationChunk.findMany({ where: { runLanguageId: lang.id } });
    expect(chunk.status).toBe('done');
    // После `checked` - только находки в глоссарий: ни перевода, ни проверки заново; дальше -
    // поля версии (`F05-6`).
    expect(calls.slice(before).map((c) => c.name)).toEqual(['metadata']);
  });

  /** Настройка этапов на время теста: строки снимаются в `finally`. */
  const withStages = async (
    stages: Array<{ stage: string; model: string } & Record<string, unknown>>,
    body: () => Promise<void>,
  ) => {
    for (const { stage, ...data } of stages) {
      await prisma.llmStageSetting.upsert({
        where: { stage },
        create: { stage, ...data } as Prisma.LlmStageSettingUncheckedCreateInput,
        update: data,
      });
    }
    try {
      await body();
    } finally {
      await prisma.llmStageSetting.deleteMany({
        where: { stage: { in: stages.map((s) => s.stage) } },
      });
    }
  };
  const JEV_ON = {
    stage: 'check_language_jev',
    model: JEV,
    enabled: true,
    maxPricePerMTok: new Prisma.Decimal(5),
  };
  /** Португальский текст: в испанском переводе - подмена языка (`product.md` §7 п.3). */
  const PT =
    'O homem não sabia o que fazer com a sua vida, e a mulher dele também não sabia. ' +
    'Eles moravam numa casa pequena perto do rio, onde passavam os dias sem pensar no futuro.';
  const chunksOf = async (runId: string, language: Language) =>
    prisma.translationChunk.findMany({
      where: { runLanguageId: (await langOf(runId, language)).id },
      orderBy: [{ chapterNumber: 'asc' }, { chunkIndex: 'asc' }],
    });
  const checks = () => calls.filter((c) => c.name === 'check_semantic');
  const semanticPass = { verdict: 'pass', samples: [], omissions: [], nameFlags: [], remarks: [] };

  it('a Portuguese piece in a Spanish translation fails the check twice and is flagged; the next chapter goes on', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);
    answer = (name, body) =>
      name === 'translation' && body.messages[1].content.includes('Reader chapter 1')
        ? {
            blocks: blocksOf(body).map((b) => ({ n: b.n, text: PT })),
            glossaryFindings: [{ source: 'Gate', target: 'Portão', kind: 'place', note: '' }],
          }
        : defaultAnswer(name, body);

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done', flaggedChunks: 1 });
    const [first, second] = await chunksOf(runId, 'es');
    expect(first).toMatchObject({ status: 'flagged', flagReason: 'LANGUAGE_MISMATCH' });
    expect(first.verdict).toMatchObject({
      failures: 2,
      attempts: [
        { outcome: 'fail', mechanical: { language: 'pt' } },
        { outcome: 'fail', mechanical: { language: 'pt' } },
      ],
    });
    // Две попытки перевода - обе в стоимости куска; смысл не сверялся: механика не прошла.
    expect(first.costUsd?.toString()).toBe('0.0002');
    expect(second.status).toBe('done');
    const own = translations().filter((c) =>
      c.body.messages[1].content.includes('Reader chapter 1'),
    );
    expect(own).toHaveLength(2);
    expect(own[0].body.messages[1].content).not.toContain('Reviewer remarks');
    expect(own[1].body.messages[1].content).toContain('Reviewer remarks');
    expect(own[1].body.messages[1].content).toContain('it reads as Portuguese');
    expect(checks()).toHaveLength(1);
    // Находки флага в глоссарий не идут (решение арбитра `F05 | F05-5`).
    const glossary = await prisma.bookGlossary.findUniqueOrThrow({
      where: { id: (await langOf(runId, 'es')).glossaryId as string },
    });
    expect(JSON.stringify(glossary.data)).not.toContain('Portão');
  });

  it('a failed meaning check and a lost name: translated again with the remarks, passes the second time; the cost is the sum of all calls', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    let semanticCalls = 0;
    answer = (name, body) => {
      if (name !== 'check_semantic') return defaultAnswer(name, body);
      semanticCalls++;
      return semanticCalls === 1
        ? {
            ...semanticPass,
            omissions: ['the greeting'],
            nameFlags: [{ key: 'anna', verdict: 'lost' }],
            remarks: ['Sample 1 changes the meaning.'],
          }
        : { ...semanticPass, nameFlags: [{ key: 'anna', verdict: 'inflected' }] };
    };

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const [chunk] = await chunksOf(runId, 'es');
    expect(chunk.status).toBe('done');
    expect(chunk.verdict).toMatchObject({
      failures: 1,
      attempts: [
        { outcome: 'fail', semantic: { model: CHECKER } },
        { outcome: 'pass', semantic: { model: CHECKER } },
      ],
    });
    // Перевод и сверка смысла дважды - сумма четырёх ответов (В7).
    expect(chunk.costUsd?.toString()).toBe('0.0004');
    expect(await langOf(runId, 'es')).toMatchObject({ flaggedChunks: 0 });
    // Имя, которого механика не нашла по основе («Ana» в «ES Anna»), - вопрос сверке смысла.
    expect(checks()[0].body.messages[1].content).toContain('anna: Anna → Ana');
    const second = translations()[1].body.messages[1].content;
    expect(second).toContain('Sample 1 changes the meaning.');
    expect(second).toContain('Missing or added: the greeting');
    expect(second).toContain('Keep the name "Ana" (source "Anna") as the glossary says.');
  });

  it('a translation again after a failed check that answers not by the form: flagged CHUNK_INVALID_RESPONSE, the attempt and its cost are in the verdict', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    answer = (name, body) => {
      if (name === 'check_semantic') return { ...semanticPass, verdict: 'fail' };
      if (name === 'translation' && body.messages[1].content.includes('Reviewer remarks')) {
        return { blocks: [], glossaryFindings: [] };
      }
      return defaultAnswer(name, body);
    };

    await drain();

    const [chunk] = await chunksOf(runId, 'es');
    expect(chunk).toMatchObject({ status: 'flagged', flagReason: 'CHUNK_INVALID_RESPONSE' });
    expect(chunk.verdict).toMatchObject({
      failures: 1,
      attempts: [
        { outcome: 'fail', translateCostUsd: '0.0001' },
        { outcome: 'invalid', translatedBy: '', translateCostUsd: '0.0003' },
      ],
    });
    // Перевод, сверка смысла и три ответа не по форме при переводе заново.
    expect(chunk.costUsd?.toString()).toBe('0.0005');
  });

  it('unsure of the meaning check is no failure: the piece is done without a second translation', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    answer = (name, body) =>
      name === 'check_semantic'
        ? { ...semanticPass, verdict: 'unsure' }
        : defaultAnswer(name, body);

    await drain();

    const [chunk] = await chunksOf(runId, 'es');
    expect(chunk.status).toBe('done');
    expect(chunk.verdict).toMatchObject({ failures: 0 });
    expect(translations()).toHaveLength(1);
  });

  it('the run started with a checker of another family; the translator falls back by 429 to the family of every checker: flagged NOT_INDEPENDENT without a meaning call or a second translation', async () => {
    await withStages(
      [
        { stage: 'translate', model: MODEL, fallbacks: [CHECKER_ALT] },
        { stage: 'check_semantic', model: CHECKER_ALT, fallbacks: [] },
      ],
      async () => {
        const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
        // Старт проходит: основная модель перевода - другого семейства, чем проверяющий.
        const started = await startRun(versionId, { languages: ['es'] }).expect(202);
        const runId = started.body.id as string;
        refuse = (name, body) =>
          name === 'translation' && body.model === MODEL
            ? json({ error: { code: 429, message: 'Rate limited' } }, 429)
            : null;

        await drain();

        const [chunk] = await chunksOf(runId, 'es');
        expect(chunk).toMatchObject({
          status: 'flagged',
          flagReason: 'NOT_INDEPENDENT',
          model: CHECKER_ALT,
        });
        expect(await langOf(runId, 'es')).toMatchObject({ status: 'done', flaggedChunks: 1 });
        expect(checks()).toHaveLength(0);
        expect(translations().filter((c) => c.model === CHECKER_ALT)).toHaveLength(1);
      },
    );
  });

  it('the source and translation do not fit the context of the checker: flagged CHECK_INPUT_TOO_LONG without a call, the language goes on', async () => {
    await withStages([{ stage: 'check_semantic', model: TINY, fallbacks: [] }], async () => {
      const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const { runId, opId } = await createRun(versionId, ['es']);

      await drain();

      expect((await opOf(opId)).status).toBe('done');
      const [chunk] = await chunksOf(runId, 'es');
      expect(chunk).toMatchObject({ status: 'flagged', flagReason: 'CHECK_INPUT_TOO_LONG' });
      expect(checks()).toHaveLength(0);
    });
  });

  it('the family rule follows the model that actually translated: after a 429 to the fallback the checker of its family is skipped', async () => {
    await withStages(
      [
        { stage: 'translate', model: MODEL, fallbacks: [ALT] },
        { stage: 'check_semantic', model: Z_CHECKER, fallbacks: [CHECKER] },
      ],
      async () => {
        const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
        const { runId } = await createRun(versionId, ['es']);
        refuse = (name, body) =>
          name === 'translation' && body.model === MODEL
            ? json({ error: { code: 429, message: 'Rate limited' } }, 429)
            : null;

        await drain();

        const [chunk] = await chunksOf(runId, 'es');
        expect(chunk).toMatchObject({ status: 'done', model: ALT });
        expect(chunk.verdict).toMatchObject({ attempts: [{ translatedBy: ALT }] });
        expect(checks().map((c) => c.model)).toEqual([CHECKER]);
      },
    );
  });

  it('Jev on: "pt" for a Spanish piece fails the mechanics and flags it after two; "unsure" is no failure; a refused call is skipped with a mark', async () => {
    await withStages([JEV_ON], async () => {
      jevTargetOf = () => 'pt';
      const wrong = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const run = await createRun(wrong.versionId, ['es']);
      await drain();
      const [flagged] = await chunksOf(run.runId, 'es');
      expect(flagged).toMatchObject({ status: 'flagged', flagReason: 'JEV_LANGUAGE_MISMATCH' });
      expect(flagged.verdict).toMatchObject({
        failures: 2,
        attempts: [
          { jev: { kind: 'answered', language: 'pt', model: JEV }, mechanical: { failures: [] } },
          { jev: { kind: 'answered', language: 'pt' } },
        ],
      });
      // Два перевода и два ответа Jev; смысл не сверялся.
      expect(flagged.costUsd?.toString()).toBe('0.0004');
      expect(checks()).toHaveLength(0);

      calls.length = 0;
      jevTargetOf = () => 'unsure';
      const unsure = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const second = await createRun(unsure.versionId, ['es']);
      await drain();
      const [passed] = await chunksOf(second.runId, 'es');
      expect(passed.status).toBe('done');
      expect(passed.verdict).toMatchObject({
        failures: 0,
        attempts: [{ jev: { kind: 'answered', language: 'unsure' }, outcome: 'pass' }],
      });

      calls.length = 0;
      refuse = (name) =>
        name === 'check_language_jev'
          ? json(
              { error: { code: 404, message: 'No endpoints found matching your data policy' } },
              404,
            )
          : null;
      const refused = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const third = await createRun(refused.versionId, ['es']);
      await drain();
      const [skipped] = await chunksOf(third.runId, 'es');
      expect(skipped.status).toBe('done');
      expect(skipped.verdict).toMatchObject({
        attempts: [
          { jev: { kind: 'skipped', code: 'LLM_NO_COMPLIANT_PROVIDER' }, outcome: 'pass' },
        ],
      });
      expect(checks()).toHaveLength(1);
    });
  });

  it('Jev: its answer is written before the decision - a step repeated after a crash does not pay it again; mechanics failed - Jev is not called', async () => {
    await withStages([JEV_ON], async () => {
      const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const { runId } = await createRun(versionId, ['es']);
      const lang = await langOf(runId, 'es');
      const jevs = () => calls.filter((c) => c.name === 'check_language_jev');
      await drain(() => Promise.resolve(jevs().length === 1 && checks().length === 0));
      const [answered] = await chunksOf(runId, 'es');
      expect(answered.status).toBe('translated');
      // Ответ Jev уже в куске и в его стоимости: перевод плюс Jev.
      expect(answered.costUsd?.toString()).toBe('0.0002');
      await prisma.llmTask.updateMany({
        where: {
          operation: { translationRun: { id: runId } },
          status: { in: ['pending', 'running'] },
        },
        data: { status: 'running', ownerToken: 'dead', leaseUntil: new Date(Date.now() - 1000) },
      });
      await drain();
      expect(jevs()).toHaveLength(1);
      const [done] = await prisma.translationChunk.findMany({ where: { runLanguageId: lang.id } });
      expect(done.status).toBe('done');
      expect(done.costUsd?.toString()).toBe('0.0003');

      calls.length = 0;
      const wrong = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const second = await createRun(wrong.versionId, ['es']);
      answer = (name, body) =>
        name === 'translation'
          ? { blocks: blocksOf(body).map((b) => ({ n: b.n, text: PT })), glossaryFindings: [] }
          : defaultAnswer(name, body);
      await drain();
      const [flagged] = await chunksOf(second.runId, 'es');
      expect(flagged).toMatchObject({ status: 'flagged', flagReason: 'LANGUAGE_MISMATCH' });
      expect(jevs()).toHaveLength(0);
    });
  });

  it('Jev: an answer not by the form is skipped with its paid answers in the cost; a money refusal pauses the run, not skipped', async () => {
    await withStages([JEV_ON], async () => {
      answer = (name, body) =>
        name === 'check_language_jev' ? { language: 'de' } : defaultAnswer(name, body);
      const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const { runId } = await createRun(versionId, ['es']);
      await drain();
      const [chunk] = await chunksOf(runId, 'es');
      expect(chunk.status).toBe('done');
      expect(chunk.verdict).toMatchObject({
        attempts: [{ jev: { kind: 'skipped', code: 'LLM_INVALID_RESPONSE', costUsd: '0.0002' } }],
      });
      // Перевод, два ответа Jev не по форме, сверка смысла.
      expect(chunk.costUsd?.toString()).toBe('0.0004');

      answer = defaultAnswer;
      refuse = (name) =>
        name === 'check_language_jev'
          ? json({ error: { code: 402, message: 'Insufficient credits' } }, 402)
          : null;
      const broke = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const run = await createRun(broke.versionId, ['es']);
      await drain();
      expect(await opOf(run.opId)).toMatchObject({
        status: 'paused',
        pauseReason: 'INSUFFICIENT_FUNDS',
      });
      const [stopped] = await chunksOf(run.runId, 'es');
      expect(stopped.status).toBe('translated');
    });
  });

  it('the meaning check answers not by the form after the remark: flagged CHUNK_CHECK_INVALID_RESPONSE with both answers paid', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    answer = (name, body) =>
      name === 'check_semantic' ? { verdict: 'maybe' } : defaultAnswer(name, body);

    await drain();

    const [chunk] = await chunksOf(runId, 'es');
    expect(chunk).toMatchObject({ status: 'flagged', flagReason: 'CHUNK_CHECK_INVALID_RESPONSE' });
    expect(chunk.verdict).toMatchObject({
      attempts: [{ outcome: 'invalid', semantic: { answer: null, costUsd: '0.0002' } }],
    });
    expect(chunk.costUsd?.toString()).toBe('0.0003');
    expect(translations()).toHaveLength(1);
  });

  it('every provider of the meaning check refuses: paused with the check models; resume with stageModels.check_semantic of another family goes on, of the same family is refused', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    refuse = (name, body) =>
      name === 'check_semantic' && body.model !== Z_CHECKER
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
    // Причина называет этап сверки: выход - stageModels.check_semantic, а не translate.
    expect(await langOf(runId, 'es')).toMatchObject({
      reason: 'CHECK_NO_COMPLIANT_PROVIDER',
      reasonModels: [CHECKER, CHECKER_ALT],
    });
    // Ход называет этап «проверка» (product.md §2.3).
    const paused = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(paused.body.languages[0]).toMatchObject({ stage: 'check' });
    const same = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { check_semantic: MODEL } })
      .expect(409);
    expect(same.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { check_semantic: Z_CHECKER } })
      .expect(200);
    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const [chunk] = await chunksOf(runId, 'es');
    expect(chunk.status).toBe('done');
    expect(chunk.verdict).toMatchObject({ attempts: [{ semantic: { model: Z_CHECKER } }] });
  });

  it('a piece translated before the checks existed (no verdict) is checked with the attempt taken from its fields', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    await drain(
      async () =>
        (await prisma.translationChunk.count({
          where: { runLanguageId: lang.id, status: 'translated' },
        })) === 1,
    );
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id },
      data: { verdict: Prisma.DbNull },
    });

    await drain();

    const [chunk] = await chunksOf(runId, 'es');
    expect(chunk.status).toBe('done');
    expect(chunk.verdict).toMatchObject({
      failures: 0,
      attempts: [{ translatedBy: MODEL, translateCostUsd: '0.0001', outcome: 'pass' }],
    });
    expect(chunk.costUsd?.toString()).toBe('0.0002');
  });

  it('the meaning check stage disabled: estimate and start refuse 409; disabled mid-run - the piece is flagged CHECK_STAGE_UNAVAILABLE and the language goes on', async () => {
    // Книга для отказов оценки и старта - первой: ответ досье в тесте - по главам последней книги.
    const other = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const { runId, opId } = await createRun(versionId, ['es']);
    await withStages(
      [{ stage: 'check_semantic', model: CHECKER, fallbacks: [], enabled: false }],
      async () => {
        const estimate = await auth(
          http()
            .get(`/admin/versions/${other.versionId}/translation-runs/estimate`)
            .query({ languages: 'es' }),
        ).expect(409);
        expect(estimate.body).toMatchObject({ code: 'LLM_STAGE_DISABLED' });
        const start = await startRun(other.versionId, { languages: ['es'] }).expect(409);
        expect(start.body).toMatchObject({ code: 'LLM_STAGE_DISABLED' });

        await drain();
      },
    );

    expect({ op: await opOf(opId), lang: await langOf(runId, 'es') }).toMatchObject({
      op: { status: 'done', pauseReason: null },
      lang: { status: 'done', flaggedChunks: 2 },
    });
    const chunks = await chunksOf(runId, 'es');
    expect(chunks.map((c) => [c.status, c.flagReason])).toEqual([
      ['flagged', 'CHECK_STAGE_UNAVAILABLE'],
      ['flagged', 'CHECK_STAGE_UNAVAILABLE'],
    ]);
    expect(translations()).toHaveLength(2);
    expect(checks()).toHaveLength(0);
  });

  it('a piece flagged by the checks does not lend its failed translation as the tail of the next piece', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId } = await createRun(versionId, ['es']);
    answer = (name, body) =>
      name === 'translation' && body.messages[1].content.includes('[1] Anna 0')
        ? { blocks: blocksOf(body).map((b) => ({ n: b.n, text: PT })), glossaryFindings: [] }
        : defaultAnswer(name, body);

    await drain();

    const [first, second] = await chunksOf(runId, 'es');
    expect(first).toMatchObject({ status: 'flagged', flagReason: 'LANGUAGE_MISMATCH' });
    expect(second.status).toBe('done');
    const next = translations().find((c) => c.body.messages[1].content.includes('Town 20'));
    expect(next?.body.messages[1].content).not.toContain('End of the previous translated piece');
    expect(next?.body.messages[1].content).not.toContain('O homem não sabia');
  });

  it('resume changing only the translate model to the family of every checker is refused 409 CHECK_MODEL_SAME_FAMILY; a fallback without a price does not count; models changed by a concurrent resume are refused', async () => {
    // Запасная другого семейства - без цены: вызов её не позовёт, и проверка не должна её считать.
    await withStages(
      [{ stage: 'check_semantic', model: CHECKER, fallbacks: [NO_PRICE] }],
      async () => {
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
        expect(await opOf(opId)).toMatchObject({ pauseReason: 'NO_COMPLIANT_PROVIDER' });

        // Модель сверки в снимке - одна `deepseek/*`: перевод тем же семейством оставил бы книгу без сверки.
        const deepseek = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
          .send({ stageModels: { translate: CHECKER } })
          .expect(409);
        expect(deepseek.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });

        // Параллельное «продолжить» сменило модели между сверкой и транзакцией - отказ, не запись.
        const operations = app.get(LlmOperationsService);
        // Подмена - на один вызов: внутри неё `operations.resume` уже настоящий.
        const raced = jest.spyOn(operations, 'resume').mockImplementationOnce(async (...args) => {
          await prisma.translationRun.update({
            where: { id: runId },
            data: { stageModels: { translate: CHECKER } },
          });
          return operations.resume(...args);
        });
        const changed = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
          .send({ stageModels: { translate: ALT } })
          .expect(409);
        expect(changed.body).toMatchObject({ code: 'TRANSLATION_RUN_MODELS_CHANGED' });
        raced.mockRestore();
        await prisma.translationRun.update({ where: { id: runId }, data: { stageModels: {} } });

        await auth(http().post(`/admin/translation-runs/${runId}/resume`))
          .send({ stageModels: { translate: ALT } })
          .expect(200);
        await drain();
        expect((await opOf(opId)).status).toBe('done');
      },
    );
  });

  it('no checker of another family than the translate model: estimate and start refuse 409 CHECK_MODEL_SAME_FAMILY; of another family - the check is in the estimate', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const estimate = (query: Record<string, string>) =>
      auth(http().get(`/admin/versions/${versionId}/translation-runs/estimate`).query(query));
    await withStages([{ stage: 'check_semantic', model: MODEL, fallbacks: [] }], async () => {
      const refused = await estimate({ languages: 'es' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });
      const start = await startRun(versionId, { languages: ['es'] }).expect(409);
      expect(start.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });
      // Модель перевода запуска другого семейства - проверяющий находится.
      const other = await estimate({ languages: 'es', translateModel: ALT }).expect(200);
      const [es] = other.body.languages as Array<Record<string, string>>;
      expect(new Prisma.Decimal(es.checkUsd).isPositive()).toBe(true);
    });
    expect(
      await runsOf(
        (await prisma.bookVersion.findUniqueOrThrow({ where: { id: versionId } })).bookId,
      ),
    ).toBe(0);
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
    // Кусок без перевода - глава не собирается, исходник вместо перевода не подставляется
    // (решение арбитра `F05 | F05-6`).
    expect(
      await prisma.translationChapter.findFirstOrThrow({
        where: { runLanguage: { runId: run.runId } },
      }),
    ).toMatchObject({ status: 'flagged', flagReason: 'CHUNK_UNTRANSLATED', length: null });
    expect(await langOf(run.runId, 'es')).toMatchObject({ flaggedChapters: 1 });
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
  // ---------------------------------------------------------------------------
  // F05-4b: оценка, старт, замок языка, запуски книги.

  const manualVersion = (bookId: string, language: Language) =>
    auth(http().post(`/books/${bookId}/versions`)).send({
      language,
      title: `Book ${language}`,
      author: 'Author',
      type: 'text',
      isFree: true,
    });

  const startRun = (versionId: string, body: Record<string, unknown>) =>
    auth(http().post(`/admin/versions/${versionId}/translation-runs`)).send(body);

  const runsOf = (bookId: string) =>
    prisma.translationRun.count({ where: { bookVersion: { bookId } } });

  it('start: one transaction - run operation by the admin with a snapshot, source and its language, a task per language without a version', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);

    const res = await startRun(versionId, { languages: ['fr', 'es'], translateModel: ALT }).expect(
      202,
    );

    const runId = res.body.id as string;
    expect(res.body).toMatchObject({
      bookVersionId: versionId,
      sourceLanguage: 'en',
      stageModels: { translate: ALT },
      operation: { kind: 'translation_run', status: 'active' },
    });
    const op = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: res.body.operation.id as string },
      include: { createdBy: { select: { email: true } } },
    });
    expect(op).toMatchObject({
      bookVersionId: versionId,
      translationRunId: runId,
      createdBy: { email: `f054-admin-${stamp}@test.com` },
    });
    // Лимит не задан - умолчание бюджета; цена модели запуска - в снимке.
    expect(op.limitUsd.toString()).toBe('10');
    const snapshot = op.settingsSnapshot as { prices: Array<{ id: string }> };
    expect(snapshot.prices.map((p) => p.id)).toContain(ALT);
    const queued = await prisma.llmTask.findMany({
      where: { operationId: op.id },
      orderBy: { language: 'asc' },
    });
    expect(queued.map((t) => [t.pairKey, t.bookVersionId])).toEqual([
      [pairKeyOf(op.id, 'es'), null],
      [pairKeyOf(op.id, 'fr'), null],
    ]);
    expect(await runsOf(bookId)).toBe(1);

    await drain();

    expect((await opOf(op.id)).status).toBe('done');
    expect(new Set(translations().map((c) => c.model))).toEqual(new Set([ALT]));
  });

  it('start refuses the whole request: a language closed by its reason, not a source, unknown model, low limit, no key', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);

    const own = await startRun(versionId, { languages: ['es', 'en'] }).expect(409);
    expect(own.body).toMatchObject({
      code: 'TRANSLATION_TARGET_UNAVAILABLE',
      languages: [{ language: 'en', reason: 'IS_SOURCE' }],
    });
    await manualVersion(bookId, 'ru').expect(201);
    const taken = await startRun(versionId, { languages: ['es', 'ru'] }).expect(409);
    expect(taken.body.languages).toEqual([{ language: 'ru', reason: 'VERSION_EXISTS' }]);
    const ru = await prisma.bookVersion.findFirstOrThrow({ where: { bookId, language: 'ru' } });
    const notSource = await startRun(ru.id, { languages: ['es'] }).expect(409);
    expect(notSource.body).toMatchObject({
      code: 'NOT_ORIGINAL_VERSION',
      sourceVersionId: versionId,
    });
    const unknown = await startRun(versionId, {
      languages: ['es'],
      translateModel: 'z/missing',
    }).expect(400);
    expect(unknown.body.code).toBe('LLM_MODEL_UNKNOWN');
    await startRun(versionId, { languages: [] }).expect(400);
    await startRun(versionId, { languages: ['es', 'es'] }).expect(400);
    // Досье и глоссарий не построены: лимит запуска обязан вместить их лимиты.
    const low = await startRun(versionId, { languages: ['es'], limitUsd: '0' }).expect(400);
    expect(low.body.code).toBe('TRANSLATION_RUN_LIMIT_TOO_LOW');
    process.env.OPENROUTER_API_KEY = '';
    await startRun(versionId, { languages: ['es'] }).expect(503);

    expect(await runsOf(bookId)).toBe(0);
    expect(await prisma.llmOperation.count({ where: { bookVersionId: versionId } })).toBe(0);
  });

  it('start with the spending ceiling reached and no dossier: the run waits DOSSIER_PAUSED for the dossier stopped on the ceiling, nothing is paid', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { spentUsd: 100 } });

    const res = await startRun(versionId, { languages: ['es'] }).expect(202);
    await drain();

    // Первый шаг - досье своей операцией: она встаёт на потолке, запуск ждёт её (Р20).
    expect(await opOf(res.body.operation.id as string)).toMatchObject({
      status: 'paused',
      pauseReason: 'DOSSIER_PAUSED',
    });
    const lang = await langOf(res.body.id as string, 'es');
    expect(await opOf(lang.blockedByOperationId as string)).toMatchObject({
      kind: 'dossier',
      status: 'paused',
      pauseReason: 'CEILING_REACHED',
    });
    expect(calls).toHaveLength(0);
  });

  it('start with the spending ceiling reached and a ready dossier and glossary: the run itself pauses CEILING_REACHED, nothing is paid', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    await startRun(versionId, { languages: ['es'] }).expect(202);
    await drain();
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { spentUsd: 100 } });
    calls.length = 0;

    const res = await startRun(versionId, { languages: ['es'] }).expect(202);
    await drain();

    expect(await opOf(res.body.operation.id as string)).toMatchObject({
      status: 'paused',
      pauseReason: 'CEILING_REACHED',
    });
    expect(calls).toHaveLength(0);
  });

  it('start of a version deleted after its estimate: 404, nothing is created', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const dossiers = app.get<DossierService>(DossierService);
    const real: DossierService['contextEstimates'] = (...args) =>
      DossierService.prototype.contextEstimates.apply(dossiers, args) as Promise<ContextEstimates>;
    jest
      .spyOn(dossiers, 'contextEstimates')
      .mockImplementationOnce(async (...args: Parameters<DossierService['contextEstimates']>) => {
        const estimate = await real(...args);
        await prisma.bookVersion.delete({ where: { id: versionId } });
        return estimate;
      });

    await startRun(versionId, { languages: ['es'] }).expect(404);

    expect(await runsOf(bookId)).toBe(0);
  });

  it('estimate refuses a bad query with 400: an unknown language, a repeated one, an unknown model', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const estimate = (query: Record<string, string | string[]>) =>
      auth(http().get(`/admin/versions/${versionId}/translation-runs/estimate`).query(query));

    await estimate({ languages: 'xx' }).expect(400);
    await estimate({ languages: ['es', 'es'] }).expect(400);
    await estimate({ languages: 'es,fr,pt,ru,en,es' }).expect(400);
    const unknown = await estimate({ languages: 'es', translateModel: 'z/missing' }).expect(400);
    expect(unknown.body.code).toBe('LLM_MODEL_UNKNOWN');
    // Повтор параметра - тот же список, что через запятую.
    const repeated = await estimate({ languages: ['es', 'fr'] }).expect(200);
    expect(repeated.body.languages.map((l: { language: string }) => l.language)).toEqual([
      'es',
      'fr',
    ]);
  });

  it('an unfinished run holds its languages (Р23): source, a second start and a manual version are refused while active or paused; cancel frees them', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const res = await startRun(versionId, { languages: ['es'] }).expect(202);
    const runId = res.body.id as string;

    const expectHeld = async () => {
      const source = await auth(
        http().get(`/admin/versions/${versionId}/translation-source`),
      ).expect(200);
      expect(source.body.targets).toContainEqual({
        language: 'es',
        available: false,
        reason: 'TRANSLATION_IN_PROGRESS',
      });
      const second = await startRun(versionId, { languages: ['fr', 'es'] }).expect(409);
      expect(second.body.languages).toEqual([
        { language: 'es', reason: 'TRANSLATION_IN_PROGRESS' },
      ]);
      const manual = await manualVersion(bookId, 'es').expect(400);
      expect(manual.body).toMatchObject({
        message: 'Translation to this language is in progress',
        code: 'TRANSLATION_IN_PROGRESS',
      });
    };

    await expectHeld();
    await auth(http().post(`/admin/translation-runs/${runId}/pause`)).expect(200);
    await expectHeld();
    await auth(http().post(`/admin/translation-runs/${runId}/cancel`)).expect(200);

    expect(await runsOf(bookId)).toBe(1);
    await manualVersion(bookId, 'es').expect(201);
  });

  it('a start and a manual version on one language at once: exactly one passes', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);

    const [started, manual] = await Promise.all([
      startRun(versionId, { languages: ['es'] }),
      manualVersion(bookId, 'es'),
    ]);

    // Первым взял замок старт - ручная версия отказывает «идёт перевод»; ручная - старт
    // отказывает «версия есть».
    expect([started.status, manual.status]).toEqual(
      started.status === 202 ? [202, 400] : [409, 201],
    );
    const versions = await prisma.bookVersion.count({ where: { bookId, language: 'es' } });
    expect(versions + (await runsOf(bookId))).toBe(1);
  });

  it('two crossing starts on the same languages: one passes, the other is refused, no deadlock', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);

    const results = await Promise.all(
      [
        ['es', 'fr'],
        ['fr', 'es'],
      ].map((languages) => startRun(versionId, { languages })),
    );

    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await runsOf(bookId)).toBe(1);
  });

  /**
   * Держит замок языка `es` транзакцией, которая пишет под ним запуск, и пускает навстречу запрос.
   * Встал ли запрос в очередь, видно по `pg_blocking_pids` против соединения держателя; без замка
   * он прошёл бы сразу по проверке до запуска.
   */
  const probeLanguageLock = async (
    send: (book: { bookId: string; versionId: string }) => Promise<request.Response>,
    underLock?: (tx: Prisma.TransactionClient, bookId: string) => Promise<unknown>,
  ) => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const opData = await llm.operationData({
      kind: 'translation_run',
      bookVersionId: versionId,
      limitUsd: new Prisma.Decimal(10),
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (pid: number) => void = () => undefined;
    const inside = new Promise<number>((resolve) => {
      entered = resolve;
    });
    // Держатель - тот же замок, что у старта: пара (книга, язык); запуск пишется под ним.
    const holder = prisma.$transaction(
      async (tx) => {
        await lockBookLanguages(tx, bookId, ['es']);
        if (underLock) {
          await underLock(tx, bookId);
        } else {
          const op = await tx.llmOperation.create({ data: opData });
          await tx.translationRun.create({
            data: {
              operationId: op.id,
              bookVersionId: versionId,
              sourceLanguage: 'en',
              languages: { create: [{ language: 'es' }] },
            },
          });
        }
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        entered(row.pid);
        await held;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const holderPid = await inside;
    const counter = send({ bookId, versionId });
    let blocked = false;
    try {
      for (let i = 0; i < 100 && !blocked; i++) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        blocked = row.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      release();
    }
    await holder;
    return { blocked, res: await counter };
  };

  it('a manual version waits for the language lock and sees the run committed while it waited', async () => {
    const { blocked, res } = await probeLanguageLock(({ bookId }) =>
      manualVersion(bookId, 'es').then((r) => r),
    );

    expect(blocked).toBe(true);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRANSLATION_IN_PROGRESS');
  }, 60_000);

  it('a start waits for the language lock and rechecks the languages under it', async () => {
    const { blocked, res } = await probeLanguageLock(({ versionId }) =>
      startRun(versionId, { languages: ['es'] }).then((r) => r),
    );

    expect(blocked).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.languages).toEqual([{ language: 'es', reason: 'TRANSLATION_IN_PROGRESS' }]);
  }, 60_000);

  it('a start waits for the language lock and rechecks the rights intake under it', async () => {
    const { blocked, res } = await probeLanguageLock(
      ({ versionId }) => startRun(versionId, { languages: ['es'] }).then((r) => r),
      async (tx, bookId) => {
        const book = await tx.book.findUniqueOrThrow({
          where: { id: bookId },
          select: { rightsIntakeId: true },
        });
        await tx.rightsIntake.update({
          where: { id: book.rightsIntakeId as string },
          data: { targetLanguages: ['en', 'fr'] },
        });
      },
    );

    expect(blocked).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.languages).toEqual([{ language: 'es', reason: 'NOT_IN_INTAKE' }]);
  }, 60_000);

  it('a source without text to translate is refused: no dossier and glossaries are paid for nothing', async () => {
    const { bookId, versionId } = await englishBook([
      { number: 1, title: 'One', content: '<hr><hr>' },
    ]);

    const est = await auth(
      http()
        .get(`/admin/versions/${versionId}/translation-runs/estimate`)
        .query({ languages: 'es' }),
    ).expect(409);
    expect(est.body.code).toBe('TRANSLATION_SOURCE_EMPTY');
    await startRun(versionId, { languages: ['es'] }).expect(409);

    expect(await runsOf(bookId)).toBe(0);
  });

  it('start with the limit exactly at the floor of the dossier and glossaries passes and keeps that limit', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const est = await auth(
      http()
        .get(`/admin/versions/${versionId}/translation-runs/estimate`)
        .query({ languages: 'es' }),
    ).expect(200);
    const floor = new Prisma.Decimal(est.body.minLimitUsd as string);

    const low = await startRun(versionId, {
      languages: ['es'],
      limitUsd: floor.sub('0.00000001').toString(),
    }).expect(400);
    expect(low.body.code).toBe('TRANSLATION_RUN_LIMIT_TOO_LOW');
    const res = await startRun(versionId, { languages: ['es'], limitUsd: floor.toString() }).expect(
      202,
    );

    expect(new Prisma.Decimal(res.body.operation.limitUsd as string).eq(floor)).toBe(true);
  });

  it('estimate: per language and total, the dossier and glossaries to build, a stale dossier, chapters near the length limit, default limit', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const estimate = async () =>
      (
        await auth(
          http()
            .get(`/admin/versions/${versionId}/translation-runs/estimate`)
            .query({ languages: 'es,fr' }),
        ).expect(200)
      ).body as {
        dossier: { suggestedLimitUsd: string } | null;
        languages: Array<{
          language: string;
          glossary: { suggestedLimitUsd: string } | null;
          splitUsd: string;
          translateUsd: string;
          checkUsd: string;
          metadataUsd: string;
          totalUsd: string;
        }>;
        translationsUsd: string;
        minLimitUsd: string;
        defaultLimitUsd: string;
        nearLimitChapters: number[];
      };
    const sum = (values: string[]) =>
      values.reduce((s, v) => s.add(v), new Prisma.Decimal(0)).toString();

    const before = await estimate();
    expect(before).toMatchObject({
      translateModel: MODEL,
      chapters: 2,
      chunks: 3,
      upperBound: true,
      nearLimitChapters: [],
    });
    expect(new Prisma.Decimal(before.defaultLimitUsd).toString()).toBe('10');
    expect(before.dossier).not.toBeNull();
    expect(before.languages.map((l) => l.language)).toEqual(['es', 'fr']);
    expect(sum(before.languages.map((l) => l.totalUsd))).toBe(
      new Prisma.Decimal(before.translationsUsd).toString(),
    );
    // Сверка смысла и поля версии - своими полями и в сумме языка (решения арбитра
    // `F05 | F05-5`, `F05 | F05-6`).
    for (const l of before.languages) {
      expect(new Prisma.Decimal(l.checkUsd).isPositive()).toBe(true);
      expect(new Prisma.Decimal(l.metadataUsd).isPositive()).toBe(true);
      expect(sum([l.splitUsd, l.translateUsd, l.checkUsd, l.metadataUsd])).toBe(
        new Prisma.Decimal(l.totalUsd).toString(),
      );
    }
    expect(
      sum([
        before.dossier?.suggestedLimitUsd ?? '0',
        ...before.languages.map((l) => l.glossary?.suggestedLimitUsd ?? 'x'),
      ]),
    ).toBe(new Prisma.Decimal(before.minLimitUsd).toString());

    // Досье и глоссарии построены запуском - строк нет, оценка не «сверху».
    await startRun(versionId, { languages: ['es', 'fr'] }).expect(202);
    await drain();
    const after = await estimate();
    expect(after).toMatchObject({ dossier: null, upperBound: false });
    expect(new Prisma.Decimal(after.minLimitUsd).isZero()).toBe(true);
    expect(after.languages.map((l) => l.glossary)).toEqual([null, null]);

    // Исходник правили - готовое досье устарело, запуск построит его заново: строка снова есть.
    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
      data: { content: `${SHORT}<p>${'x'.repeat(400_001)}</p>` },
    });
    const stale = await estimate();
    expect(stale.dossier).not.toBeNull();
    expect(stale.nearLimitChapters).toEqual([2]);
  });

  it('runs of the book: paginated, newest first, only this book', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const other = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const first = await startRun(versionId, { languages: ['es'] }).expect(202);
    await auth(http().post(`/admin/translation-runs/${first.body.id as string}/cancel`)).expect(
      200,
    );
    const second = await startRun(versionId, { languages: ['fr', 'es'] }).expect(202);
    await startRun(other.versionId, { languages: ['es'] }).expect(202);

    const res = await auth(http().get(`/admin/books/${bookId}/translation-runs`)).expect(200);

    expect(res.body.pagination).toEqual({ page: 1, limit: 10, total: 2, totalPages: 1 });
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([
      second.body.id,
      first.body.id,
    ]);
    expect(res.body.items[0]).toMatchObject({
      bookVersionId: versionId,
      sourceLanguage: 'en',
      languages: ['es', 'fr'],
      operation: { status: 'active' },
    });
    expect(res.body.items[1].operation.status).toBe('cancelled');
    await auth(
      http().get(`/admin/books/00000000-0000-0000-0000-000000000000/translation-runs`),
    ).expect(404);
  });

  it('a chapter longer than the limit is flagged with its length and limit, the other chapter is assembled (Р8)', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: '<p>Big chapter.</p>' },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    answer = (name, body) => {
      const base = defaultAnswer(name, body);
      if (name !== 'translation' || !body.messages[1].content.includes('Big chapter')) return base;
      return { ...(base as object), blocks: [{ n: 1, text: 'x'.repeat(500_001) }] };
    };
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 1 });
    const chapters = await prisma.translationChapter.findMany({
      where: { runLanguageId: lang.id },
      orderBy: { chapterNumber: 'asc' },
    });
    expect(chapters.map((c) => [c.status, c.flagReason, c.lengthLimit])).toEqual([
      ['flagged', 'CHAPTER_TOO_LONG', 500_000],
      ['assembled', null, 500_000],
    ]);
    expect(chapters[0].length).toBeGreaterThan(500_000);
  });

  it('a block repeated on a seam flags the chapter with the seam number; the chapter still goes to the draft', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    let lastBlock = '';
    answer = (name, body) => {
      const base = defaultAnswer(name, body) as { blocks: Array<{ n: number; text: string }> };
      if (name !== 'translation') return base;
      // Второй кусок начинается повтором последнего блока первого (модель повторила хвост).
      const blocks = body.messages[1].content.includes('End of the previous translated piece')
        ? base.blocks.map((b, i) => (i === 0 ? { n: b.n, text: lastBlock } : b))
        : base.blocks;
      lastBlock = blocks[blocks.length - 1].text;
      return { ...base, blocks };
    };
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 1 });
    expect(
      await prisma.translationChapter.findFirstOrThrow({ where: { runLanguageId: lang.id } }),
    ).toMatchObject({
      status: 'assembled',
      flagReason: 'SEAM_REPEAT',
      seamIndex: 1,
      findings: [{ code: 'SEAM_REPEAT', seam: 1 }],
    });
  });

  // Текст главы ловит и сверка кусков главы при сборке; название - только сверка отпечатка
  // исходника перед сборкой (карточка, «От `F05-4a`»).
  it.each([
    ['text', { content: '<p>Anna leaves at night.</p>' }],
    ['title', { title: 'One, revised' }],
  ])(
    'the %s of a translated chapter edited later pauses DOSSIER_STALE before assembly',
    async (_what, data) => {
      const { versionId } = await englishBook([
        { number: 1, title: 'One', content: '<p>Anna leaves.</p>' },
        { number: 2, title: 'Two', content: SHORT },
      ]);
      during = async (name) => {
        const last = calls[calls.length - 1];
        if (name !== 'translation' || !last.body.messages[1].content.includes('Anna arrives'))
          return;
        await prisma.chapter.update({
          where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
          data,
        });
      };
      const { runId, opId } = await createRun(versionId, ['es']);

      await drain();

      expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
      const lang = await langOf(runId, 'es');
      expect(lang).toMatchObject({ status: 'running', reason: 'DOSSIER_STALE', metadata: null });
      expect(await prisma.translationChapter.count({ where: { runLanguageId: lang.id } })).toBe(0);
      expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(0);
    },
  );

  it('version fields in a foreign language: one retry with the remarks, then the language fails METADATA_INVALID', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    answer = (name, body) => {
      const base = defaultAnswer(name, body);
      if (name !== 'metadata') return base;
      return { ...(base as object), title: 'The man who was in the house of the old woman' };
    };
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    const metadata = calls.filter((c) => c.name === 'metadata');
    expect(metadata).toHaveLength(2);
    expect(metadata[0].body.messages[1].content).not.toContain('The previous answer failed');
    expect(metadata[1].body.messages[1].content).toContain(
      'The title is not in Spanish: it reads as English.',
    );
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'failed', reason: 'METADATA_INVALID' });
    expect(lang.metadata).toMatchObject({
      result: null,
      attempts: [
        { model: MODEL, outcome: 'fail', costUsd: '0.0001' },
        { model: MODEL, outcome: 'fail', costUsd: '0.0001' },
      ],
    });
    expect((await opOf(opId)).status).toBe('done');
  });

  it('a version fields answer saved before the step is recorded is not paid again; the stage reads assemble meanwhile', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const saved = async () => (await langOf(runId, 'es')).metadata !== null;
    await drain(saved);
    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(1);
    const assembling = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(assembling.body.languages[0]).toMatchObject({ status: 'running', stage: 'assemble' });

    // Исполнитель умер после записи ответа, до итога шага (как у куска выше).
    await prisma.llmTask.updateMany({
      where: {
        operation: { translationRun: { id: runId } },
        status: { in: ['pending', 'running'] },
      },
      data: { status: 'running', ownerToken: 'dead', leaseUntil: new Date(Date.now() - 1000) },
    });
    await drain();

    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(1);
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
  });

  it('every provider of the version fields refuses: paused with the stage models; resume with stageModels.metadata goes on', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    refuse = (name, body) =>
      name === 'metadata' && body.model !== ALT
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
      status: 'running',
      reason: 'METADATA_NO_COMPLIANT_PROVIDER',
      reasonModels: [MODEL],
      metadata: null,
    });
    const paused = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(paused.body.languages[0]).toMatchObject({ stage: 'assemble' });
    // Параллельное «продолжить» сменило модель полей версии - отказ, а не запись мимо сверки.
    const operations = app.get(LlmOperationsService);
    const raced = jest.spyOn(operations, 'resume').mockImplementationOnce(async (...args) => {
      await prisma.translationRun.update({
        where: { id: runId },
        data: { stageModels: { metadata: MODEL } },
      });
      return operations.resume(...args);
    });
    const changed = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { metadata: ALT } })
      .expect(409);
    expect(changed.body).toMatchObject({ code: 'TRANSLATION_RUN_MODELS_CHANGED' });
    raced.mockRestore();
    await prisma.translationRun.update({ where: { id: runId }, data: { stageModels: {} } });
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { metadata: ALT } })
      .expect(200);
    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done' });
    expect(lang.metadata).toMatchObject({ attempts: [{ model: ALT, outcome: 'pass' }] });
  });

  it('version fields that do not fit the model context: the language fails METADATA_TOO_LONG without a call', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    let run: { runId: string; opId: string } = { runId: '', opId: '' };
    await withStages([{ stage: 'metadata', model: TINY, fallbacks: [] }], async () => {
      run = await createRun(versionId, ['es']);
    });

    await drain();

    expect(await langOf(run.runId, 'es')).toMatchObject({
      status: 'failed',
      reason: 'METADATA_TOO_LONG',
      metadata: null,
    });
    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(0);
    expect((await opOf(run.opId)).status).toBe('done');
  });

  it('the version fields stage disabled: estimate and start refuse 409 LLM_STAGE_DISABLED', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    await withStages(
      [{ stage: 'metadata', model: MODEL, fallbacks: [], enabled: false }],
      async () => {
        const estimate = await auth(
          http()
            .get(`/admin/versions/${versionId}/translation-runs/estimate`)
            .query({ languages: 'es' }),
        ).expect(409);
        expect(estimate.body).toMatchObject({ code: 'LLM_STAGE_DISABLED' });
        const start = await startRun(versionId, { languages: ['es'] }).expect(409);
        expect(start.body).toMatchObject({ code: 'LLM_STAGE_DISABLED' });
      },
    );
  });

  it('version fields not in the answer form after the retry with a remark: the language fails METADATA_INVALID without another round', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    answer = (name, body) =>
      name === 'metadata' ? { title: 'Sin forma' } : defaultAnswer(name, body);
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    // Ответ и повтор с замечанием о форме - два вызова, третьего нет.
    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(2);
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'failed', reason: 'METADATA_INVALID' });
    expect(lang.metadata).toMatchObject({
      result: null,
      attempts: [{ model: '', outcome: 'invalid', costUsd: '0.0002' }],
    });
  });

  it('estimate of the version fields before the dossier and glossary exist is an upper bound over their size', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const estimate = async () =>
      (
        await auth(
          http()
            .get(`/admin/versions/${versionId}/translation-runs/estimate`)
            .query({ languages: 'es' }),
        ).expect(200)
      ).body as { upperBound: boolean; languages: Array<{ metadataUsd: string }> };
    const before = await estimate();
    expect(before.upperBound).toBe(true);
    await startRun(versionId, { languages: ['es'] }).expect(202);
    await drain();
    const after = await estimate();
    expect(after.upperBound).toBe(false);
    // Сверху - вход сверх промпта в размер ответов досье и глоссария: дороже, чем по готовым.
    expect(
      new Prisma.Decimal(before.languages[0].metadataUsd).greaterThan(
        after.languages[0].metadataUsd,
      ),
    ).toBe(true);
  });
});
