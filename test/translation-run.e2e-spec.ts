/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { createHash } from 'crypto';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, LlmTask, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID, LlmBudgetService } from '../src/modules/llm/llm-budget.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmTaskService, pairKeyOf } from '../src/modules/llm-worker/llm-task.service';
import { TRANSLATION_RETRY_KIND } from '../src/modules/llm-worker/llm-task.types';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { LlmWorkerConfig } from '../src/modules/llm-worker/llm-worker.config';
import { LlmOperationsService } from '../src/modules/llm-worker/llm-operations.service';
import { lockBookLanguages } from '../src/modules/book-version/book-language-lock';
import { ChapterService } from '../src/modules/chapter/chapter.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { TranslationDraftService } from '../src/modules/translation/draft/translation-draft.service';
import {
  DOSSIER_LIMIT_TOO_LOW,
  RUN_HISTORY_STAGES,
} from '../src/modules/translation/run/translation-run.constants';
import { BookVersionService } from '../src/modules/book-version/book-version.service';
import { CreateFromRunRejectedError } from '../src/modules/book-version/create-from-run';
import {
  ContextEstimates,
  DossierService,
} from '../src/modules/translation/dossier/dossier.service';
import { runTaskInput } from '../src/modules/translation/run/translation-run.service';
import { TranslationRunReportDto } from '../src/modules/translation/dto/translation-run-report-response.dto';
import { sourceFingerprint } from '../src/modules/translation/source-fingerprint';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
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
  /** Умолчание этапа `translate` (Р2 `F05 | F05-R`); его запасная - `MODEL`. */
  const TRANSLATOR = 'openai/gpt-5.6-terra';
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
      TRANSLATOR,
      ALT,
      TINY,
      NO_PRICE,
      CHECKER,
      CHECKER_ALT,
      JEV,
      Z_CHECKER,
      'google/gemma-4-31b-it:free',
      'xingchen-agi/xing4.0-29b-a4b:free',
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

  /**
   * Перевод держит имя глоссария («Anna» → «Ana»): чистый перевод итоговая проверка не флагует
   * (`F05-6c`). `keepNames` - перевод оставил исходное написание: потерянное имя для сверки
   * смысла и второе написание для итоговой проверки.
   */
  let keepNames = false;

  /** Блоки куска из запроса: `[n] текст` построчно после заголовка. */
  const blocksOf = (body: ChatBody) => {
    const user = body.messages[1]?.content ?? '';
    const list = user.split('Blocks to translate, as "[n] text":\n')[1] ?? '';
    return list
      .split('\n')
      .map((line) => /^\[(\d+)\] (.*)$/s.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        n: Number(m[1]),
        text: `${targetOf(body).toUpperCase()} ${keepNames ? m[2] : m[2].replace(/\bAnna\b/g, 'Ana')}`,
      }));
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
    if (name === 'check_seam') return { verdict: 'pass', problems: [] };
    if (name === 'final_check') return { verdict: 'pass', issues: [] };
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

  /** Редактор удалил черновики запуска: язык книги снова свободен для нового запуска и оценки. */
  const dropDrafts = async (bookId: string) => {
    await prisma.bookVersion.deleteMany({ where: { bookId, language: { not: 'en' } } });
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

  /**
   * Сколько задач исполнитель взял за один проход (`runOnce`): взятые задачи идут одновременно,
   * каждая в своём слоте, - мера одновременности языков без таймеров (`F05-8`).
   */
  const slotsInOnePass = () => {
    // `bind` без `strictBindCallApply` теряет тип: метод - своим типом.
    const claim = tasks.claim.bind(tasks) as LlmTaskService['claim'];
    const runOnce = worker.runOnce.bind(worker) as LlmWorkerService['runOnce'];
    let pass = 0;
    let peak = 0;
    jest
      .spyOn(tasks, 'claim')
      .mockImplementation(async (...args: Parameters<LlmTaskService['claim']>) => {
        const task = await claim(...args);
        if (task) pass += 1;
        return task;
      });
    jest.spyOn(worker, 'runOnce').mockImplementation(async () => {
      pass = 0;
      await runOnce();
      peak = Math.max(peak, pass);
    });
    return { peak: () => peak };
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
    keepNames = false;
    // Jev включён по умолчанию (`F05-R`): называет язык подменённого перевода - по его метке.
    jevTargetOf = (body) =>
      /<<<TEXT\n(EN|ES|FR|PT|RU) /.exec(body.messages[1]?.content ?? '')?.[1].toLowerCase() ??
      'unsure';
    dossier = DOSSIER;
    refuse = () => null;
    during = () => Promise.resolve();
    costOf = () => 0.0001;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (urlOf(url).endsWith('/models')) return json(MODELS);
      if (urlOf(url).endsWith('/chat/completions')) {
        const body = JSON.parse((init as RequestInit).body as string) as ChatBody;
        const name = llmCallName(body);
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
      ['get', `/admin/translation-runs/${id}/report`],
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

  it('two languages: one dossier, a glossary each, pieces in order, findings of piece N in the prompt of N+1, chapters assembled, version fields translated, a draft version with the chapters written', async () => {
    const { bookId, versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    // Исходник с заполненными полями: «скопировано» и «оставлено пустым» у черновика
    // различимы, а не совпадают на `null = null` (`expectDraft`).
    const category = await prisma.category.create({
      data: { type: 'genre', name: 'Drama', slug: `f056-${stamp}-c`, key: `f056-${stamp}-c` },
    });
    const tag = await prisma.tag.create({
      data: { name: 'Sea', slug: `f056-${stamp}-t`, key: `f056-${stamp}-t` },
    });
    const seo = await prisma.seo.create({ data: { metaTitle: 'Meta en' } });
    await prisma.bookVersion.update({
      where: { id: versionId },
      data: {
        referralUrl: 'https://example.com/buy',
        firstPublishedYear: 1851,
        editionPublishedYear: 2001,
        originalTitle: 'The Book',
        primaryCategoryId: category.id,
        shortDescription: 'Short en',
        summaryShort: 'Summary en',
        coverAlt: 'Cover en',
        authorPageUrl: 'https://example.com/author',
        copyrightStatus: 'public_domain',
        seoId: seo.id,
        themes: ['sea'],
        alternativeTitles: ['Other en'],
        categories: { create: { categoryId: category.id } },
        tags: { create: { tagId: tag.id } },
      },
    });
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
      // Кусок проверен (`F05-5`): механика прошла, Jev (включён по умолчанию с `F05-R`) назвал
      // язык перевода, смысл - моделью другого семейства; перевод - умолчанием этапа (Р2).
      expect(chunks.every((c) => c.status === 'done')).toBe(true);
      for (const c of chunks) {
        expect(c.verdict).toMatchObject({
          failures: 0,
          remarks: [],
          attempts: [
            {
              translatedBy: TRANSLATOR,
              outcome: 'pass',
              jev: { kind: 'answered', language },
              semantic: { model: CHECKER },
              mechanical: { failures: [] },
            },
          ],
        });
      }
      expect(chunks.map((c) => c.costUsd?.toString())).toEqual(['0.0003', '0.0003', '0.0003']);
      // Jev включён по умолчанию - один вызов на кусок языка.
      expect(
        calls.filter(
          (c) =>
            c.name === 'check_language_jev' &&
            c.body.messages[1].content.includes(`<<<TEXT\n${language.toUpperCase()} `),
        ),
      ).toHaveLength(3);
      expect((chunks[0].blocks as Array<{ text: string }>)[0].text).toMatch(
        new RegExp(`^${language.toUpperCase()} Ana 0`),
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
    // Черновик версии (`F05-6`, 6b): по версии на язык, главы записаны, ссылка языка на версию.
    expect(await prisma.bookVersion.count({ where: { bookId } })).toBe(3);
    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(2);
    for (const language of ['es', 'fr'] as const) {
      const lang = await langOf(runId, language);
      expect(lang).toMatchObject({ flaggedChapters: 0 });
      expect(lang.bookVersionId).not.toBeNull();
      const chapters = await prisma.translationChapter.findMany({
        where: { runLanguageId: lang.id },
        orderBy: { chapterNumber: 'asc' },
      });
      expect(chapters.map((c) => [c.chapterNumber, c.status, c.flagReason, c.lengthLimit])).toEqual(
        [
          [1, 'written', null, 500_000],
          [2, 'written', null, 500_000],
        ],
      );
      await expectDraft(lang, language, bookId);
      const tag = language.toUpperCase();
      expect(chapters[1].length).toBe(
        `<p>${tag} Ana arrives.</p><p>${tag} — Hello, Annie.</p>`.length,
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
      flaggedChapters: 0,
      draftVersionId: (await langOf(runId, 'es')).bookVersionId,
    });
    // Досье и два глоссария - своими строками, без операции самого запуска (`F05-7`, В1).
    const own = await prisma.llmOperation.findMany({
      where: { translationRunId: runId, kind: 'dossier' },
      orderBy: { createdAt: 'asc' },
    });
    const body = res.body as { operation: { id: string }; operations: Array<{ id: string }> };
    expect(own).toHaveLength(3);
    expect(body.operations.map((o) => o.id)).toEqual(own.map((o) => o.id));
    expect(body.operations.map((o) => o.id)).not.toContain(body.operation.id);
  });

  /**
   * Черновик языка по карточке `F05-6`, шаг 6: переведённые поля из `metadata`, копируемые с
   * исходника, пустые, снимок прав как у ручной версии, статус `draft`; главы записаны тем же
   * путём, что ручные, `writtenHash` - sha256 очищенного `content`.
   */
  const expectDraft = async (
    lang: Awaited<ReturnType<typeof langOf>>,
    language: Language,
    bookId: string,
  ) => {
    const tag = language.toUpperCase();
    const draft = await prisma.bookVersion.findUniqueOrThrow({
      where: { id: lang.bookVersionId as string },
      include: { chapters: { orderBy: { number: 'asc' } } },
    });
    const book = await prisma.book.findUniqueOrThrow({ where: { id: bookId } });
    const source = await prisma.bookVersion.findFirstOrThrow({
      where: { bookId, language: 'en' },
    });
    expect(draft).toMatchObject({
      bookId,
      language,
      status: 'draft',
      title: `${tag} Book en`,
      author: `${tag} Author`,
      description: `${tag} Desc`,
      type: source.type,
      isFree: source.isFree,
      coverImageUrl: source.coverImageUrl,
      referralUrl: source.referralUrl,
      firstPublishedYear: source.firstPublishedYear,
      editionPublishedYear: source.editionPublishedYear,
      originalLanguage: source.originalLanguage,
      originalTitle: source.originalTitle,
      authorId: source.authorId,
      slug: null,
      authorPageUrl: null,
      previewMediaId: null,
      copyrightStatus: null,
      shortDescription: null,
      summaryShort: null,
      coverAlt: null,
      seoId: null,
      characters: null,
      quotes: null,
      faq: null,
      themes: null,
      symbols: null,
      alternativeTitles: null,
      primaryCategoryId: source.primaryCategoryId,
      rightsProfileId: source.rightsProfileId ?? book.currentRightsProfileId,
      approvedRightsReviewId: source.approvedRightsReviewId ?? book.approvedRightsReviewId,
      rightsGeoBlockConfigured: false,
    });
    const [categories, tags, contributors] = await Promise.all([
      prisma.bookCategory.findMany({ where: { bookVersionId: draft.id } }),
      prisma.bookTag.findMany({ where: { bookVersionId: draft.id } }),
      prisma.bookVersionContributor.count({ where: { bookVersionId: draft.id } }),
    ]);
    const [sourceCategories, sourceTags] = await Promise.all([
      prisma.bookCategory.findMany({ where: { bookVersionId: source.id } }),
      prisma.bookTag.findMany({ where: { bookVersionId: source.id } }),
    ]);
    expect(categories.map((c) => c.categoryId).sort()).toEqual(
      sourceCategories.map((c) => c.categoryId).sort(),
    );
    expect(tags.map((t) => t.tagId).sort()).toEqual(sourceTags.map((t) => t.tagId).sort());
    expect(contributors).toBe(0);
    expect(draft.chapters.map((c) => [c.number, c.title])).toEqual([
      [1, `${tag} One`],
      [2, `${tag} Two`],
    ]);
    const rows = await prisma.translationChapter.findMany({
      where: { runLanguageId: lang.id },
      orderBy: { chapterNumber: 'asc' },
    });
    expect(rows.map((r) => r.chapterId)).toEqual(draft.chapters.map((c) => c.id));
    expect(rows.map((r) => r.writtenHash)).toEqual(
      draft.chapters.map((c) => createHash('sha256').update(c.content).digest('hex')),
    );
  };

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

  it('four languages on four slots, the limit on two and a half languages: the run spends no more than its limit, each dossier and glossary operation no more than its own, each language keeps its piece order (F05-8, §7 п.6)', async () => {
    jest.spyOn(app.get(LlmWorkerConfig), 'concurrency').mockReturnValue(4);
    // Резерв вызова перевода - с запасом над фактом (условие посадки: факт не больше резерва),
    // даже когда лимит запуска поднят до крупнейшей операции досье или глоссария.
    await prisma.llmStageSetting.upsert({
      where: { stage: 'translate' },
      create: { stage: 'translate', model: MODEL, maxTokens: 50_000 },
      update: { maxTokens: 50_000 },
    });
    try {
      const { versionId } = await englishBook([
        { number: 1, title: 'One', content: LONG },
        { number: 2, title: 'Two', content: SHORT },
      ]);
      const four: Language[] = ['es', 'fr', 'pt', 'ru'];
      const slots = slotsInOnePass();
      // Досье и глоссарии строятся внутри запуска своими операциями: тратят свой лимит, но каждая
      // обязана влезть в остаток запуска (С12; решение арбитра `F05 | F05-8`, В1 - мера перерасхода
      // - операция запуска). Лимит - не ниже самой крупной из них, а перевод стоит так, что лимит
      // покрывает ровно два с половиной языка: три куска на язык.
      const estimate = await auth(
        http()
          .get(`/admin/versions/${versionId}/translation-runs/estimate`)
          .query({ languages: four.join(',') }),
      ).expect(200);
      const body = estimate.body as {
        dossier: { suggestedLimitUsd: string } | null;
        languages: Array<{ glossary: { suggestedLimitUsd: string } | null }>;
      };
      const side = [body.dossier, ...body.languages.map((l) => l.glossary)].flatMap((x) =>
        x ? [Number(x.suggestedLimitUsd)] : [],
      );
      const limitUsd = Math.max(0.075, ...side);
      const limit = limitUsd.toFixed(8);
      const fact = Number((limitUsd / 7.5).toFixed(8));
      // Нарезка - на бесплатной модели (резерв 0): честный провайдер берёт за неё 0.
      costOf = (name) => (name === 'translation' ? fact : name === 'split' ? 0 : 0.0001);
      const { runId, opId } = await createRun(versionId, four, limit);
      await drain();

      const paused = await opOf(opId);
      expect(paused).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
      // Факт не больше резерва: перерасхода нет вовсе (В2).
      expect(paused.spentUsd.lte(new Prisma.Decimal(limit))).toBe(true);
      expect(paused.reservedUsd.isZero()).toBe(true);
      // Условие посадки: факт каждого вызова запуска не больше его резерва.
      const paid = await prisma.llmCall.findMany({
        where: { operationId: opId, costUsd: { not: null } },
      });
      for (const c of paid) expect(c.costUsd!.lte(c.reservedUsd)).toBe(true);
      // Пауза - от лимита: язык не уложил резерв вызова или глоссарий в остаток запуска.
      const stopped = await prisma.translationRunLanguage.findMany({
        where: { runId, status: { not: 'done' } },
        select: { reason: true },
      });
      expect(stopped.length).toBeGreaterThan(0);
      // Язык, чей шаг ждал в очереди, когда операция встала, своей причины не пишет (`null`);
      // у остальных - только лимит, и хотя бы один встал на резерве вызова.
      for (const l of stopped) {
        expect(['LLM_BUDGET_EXCEEDED:operation', DOSSIER_LIMIT_TOO_LOW, null]).toContain(l.reason);
      }
      expect(stopped.some((l) => l.reason === 'LLM_BUDGET_EXCEEDED:operation')).toBe(true);
      // Языки шли одновременно: в одном проходе исполнитель держал не меньше трёх задач.
      expect(slots.peak()).toBeGreaterThanOrEqual(3);
      // Пауза не до работы (решение арбитра `F05 | F05-8`, круг 2): оплачен хотя бы один кусок.
      expect(translations().length).toBeGreaterThanOrEqual(1);
      expect(translations().length).toBeLessThan(12);
      const ops = await prisma.llmOperation.findMany({
        where: { translationRunId: runId, NOT: { id: opId } },
      });
      // Досье и глоссарии - каждая операция в пределах своего лимита.
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) expect(op.spentUsd.lte(op.limitUsd)).toBe(true);

      await auth(http().post(`/admin/translation-runs/${runId}/resume`))
        .send({ limitUsd: '10' })
        .expect(200);
      await drain();
      expect((await opOf(opId)).status).toBe('done');
      for (const language of four) {
        const lang = await langOf(runId, language);
        const pieces = await prisma.translationChunk.findMany({
          where: { runLanguageId: lang.id },
          orderBy: [{ chapterNumber: 'asc' }, { chunkIndex: 'asc' }],
          select: { callId: true },
        });
        expect(pieces).toHaveLength(3);
        const started = await Promise.all(
          pieces.map(async (p) =>
            (
              await prisma.llmCall.findUniqueOrThrow({ where: { id: p.callId as string } })
            ).startedAt.getTime(),
          ),
        );
        // Язык идёт по своим кускам по порядку: глава за главой, кусок за куском.
        expect(started).toEqual([...started].sort((a, b) => a - b));
      }
      // Каждый кусок оплачен ровно раз.
      expect(translations()).toHaveLength(12);
    } finally {
      await prisma.llmStageSetting.deleteMany({ where: { stage: 'translate' } });
    }
  });

  it('a call whose fact exceeds its reserve: the run overspends by no more than that difference and reserves nothing after paying it (F05-8, В2)', async () => {
    jest.spyOn(app.get(LlmWorkerConfig), 'concurrency').mockReturnValue(4);
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const four: Language[] = ['es', 'fr', 'pt', 'ru'];
    let first = true;
    // Первый перевод провайдер оценил дороже резерва, остальные - честно (нарезка - бесплатная
    // модель с резервом 0).
    costOf = (name) => {
      if (name === 'split') return 0;
      if (name !== 'translation') return 0.0001;
      if (!first) return 0.01;
      first = false;
      return 1;
    };
    // Порядок по завершению вызовов бюджета, а не по отметкам времени: `startedAt` и
    // `reserveReleasedAt` - начало своих транзакций, а не их запись.
    type ReserveArgs = Parameters<LlmBudgetService['reserve']>;
    type SettleArgs = Parameters<LlmBudgetService['settle']>;
    const budget = app.get(LlmBudgetService);
    const reserve = budget.reserve.bind(budget) as LlmBudgetService['reserve'];
    const settle = budget.settle.bind(budget) as LlmBudgetService['settle'];
    let paid = false;
    let lateReserves = 0;
    jest.spyOn(budget, 'reserve').mockImplementation(async (input: ReserveArgs[0]) => {
      // Резерв, начатый после оплаты дорогого вызова, видит spent выше лимита и обязан отказать;
      // начатый до неё может закончиться позже - он не в счёт.
      const afterPayment = paid;
      const reserved = await reserve(input);
      if (afterPayment) lateReserves += 1;
      return reserved;
    });
    jest
      .spyOn(budget, 'settle')
      .mockImplementation(async (callId: SettleArgs[0], outcome: SettleArgs[1]) => {
        const settled = await settle(callId, outcome);
        if (outcome.costUsd.eq(1)) paid = true;
        return settled;
      });
    const limit = '0.5';
    const { opId } = await createRun(versionId, four, limit);
    await drain();

    const paused = await opOf(opId);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
    const over = await prisma.llmCall.findFirstOrThrow({
      where: { operationId: opId, stage: 'translate', costUsd: new Prisma.Decimal(1) },
    });
    // Честные вызовы в полёте добавляют к перерасходу не больше нуля (факт не больше резерва):
    // предел - разница дорогого вызова, а не «вызовов по числу слотов».
    const overspend = paused.spentUsd.sub(new Prisma.Decimal(limit));
    expect(overspend.gt(0)).toBe(true);
    expect(overspend.lte(over.costUsd!.sub(over.reservedUsd))).toBe(true);
    // После оплаты дорогого вызова ни одного нового резерва: spent уже выше лимита.
    expect(paid).toBe(true);
    expect(lateReserves).toBe(0);
  });

  it('four languages on four slots under the spending ceiling: the run pauses CEILING_REACHED and the budget never passes the ceiling (F05-8, карточка шаг 1)', async () => {
    jest.spyOn(app.get(LlmWorkerConfig), 'concurrency').mockReturnValue(4);
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const four: Language[] = ['es', 'fr', 'pt', 'ru'];
    // Досье и глоссарии готовы заранее: общий бюджет тратит только перевод запуска.
    const warm = await createRun(versionId, four);
    await drain(
      async () =>
        (await prisma.translationRunLanguage.count({
          where: { runId: warm.runId, glossaryId: { not: null } },
        })) === 4,
    );
    await prisma.llmOperation.update({ where: { id: warm.opId }, data: { status: 'cancelled' } });
    await prisma.llmTask.updateMany({
      where: { operationId: warm.opId, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled' },
    });
    calls.length = 0;
    // Потолок на два с половиной языка по два куска по 0,03 (резерв вызова около 0,035 - в полёте
    // до четырёх); лимит запуска его не держит.
    const ceiling = '0.15';
    await prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: ceiling, reservedUsd: 0, spentUsd: 0 },
    });
    costOf = (name) => (name === 'translation' ? 0.03 : name === 'split' ? 0 : 0.0001);
    const slots = slotsInOnePass();
    const { opId } = await createRun(versionId, four, '10');
    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'CEILING_REACHED' });
    const budget = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
    expect(budget.reservedUsd.isZero()).toBe(true);
    expect(budget.spentUsd.lte(new Prisma.Decimal(ceiling))).toBe(true);
    // Условие посадки: факт каждого вызова не больше его резерва; языки шли одновременно.
    const paid = await prisma.llmCall.findMany({
      where: { operationId: opId, costUsd: { not: null } },
    });
    for (const c of paid) expect(c.costUsd!.lte(c.reservedUsd)).toBe(true);
    expect(slots.peak()).toBeGreaterThanOrEqual(3);
    expect(translations().length).toBeGreaterThan(0);
    expect(translations().length).toBeLessThan(8);
    expect(await prisma.llmTask.count({ where: { operationId: opId, status: 'pending' } })).toBe(0);
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
    // итоговая проверка и поля версии (`F05-6`).
    expect(calls.slice(before).map((c) => c.name)).toEqual(['final_check', 'metadata']);
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
    keepNames = true;
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
    // Перевод, Jev и сверка смысла дважды - сумма шести ответов (В7).
    expect(chunk.costUsd?.toString()).toBe('0.0006');
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
    // Перевод, Jev, сверка смысла и три ответа не по форме при переводе заново.
    expect(chunk.costUsd?.toString()).toBe('0.0006');
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
    // Перевод, Jev и два ответа сверки смысла.
    expect(chunk.costUsd?.toString()).toBe('0.0004');
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
      .send({ stageModels: { check_semantic: TRANSLATOR } })
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
      attempts: [{ translatedBy: TRANSLATOR, translateCostUsd: '0.0001', outcome: 'pass' }],
    });
    // Перевод, Jev и сверка смысла.
    expect(chunk.costUsd?.toString()).toBe('0.0003');
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
          name === 'translation' && [TRANSLATOR, MODEL].includes(body.model)
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
    await withStages([{ stage: 'check_semantic', model: TRANSLATOR, fallbacks: [] }], async () => {
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

  it('the estimate counts Jev per piece while the stage is on; off - not counted and no refusal (Р9 F05-R)', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const checkUsdOf = async () => {
      const res = await auth(
        http()
          .get(`/admin/versions/${versionId}/translation-runs/estimate`)
          .query({ languages: 'es' }),
      ).expect(200);
      return new Prisma.Decimal((res.body.languages as Array<{ checkUsd: string }>)[0].checkUsd);
    };
    const on = await checkUsdOf();
    let off = on;
    await withStages([{ ...JEV_ON, enabled: false }], async () => {
      off = await checkUsdOf();
    });
    // Два куска главы - два вызова Jev по потолку цены этапа со служебным входом роутера.
    // `isPositive()` у Decimal верно и для нуля - нужна строгая разница.
    expect(on.sub(off).gt(0)).toBe(true);
  });

  it('a stop found while the pause button already stopped the run still sets its reason', async () => {
    // Одна модель перевода: её отказ - последний, пауза не обрывает переход на запасную.
    await withStages([{ stage: 'translate', model: TRANSLATOR, fallbacks: [] }], async () => {
      const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
      const { runId, opId } = await createRun(versionId, ['es']);
      refuse = (name, body) =>
        name === 'translation' && body.model === TRANSLATOR
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
        reasonModels: [TRANSLATOR],
      });
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
    // Ни одной главы к записи - черновика нет, язык закрыт своим кодом (решение арбитра
    // `F05 | F05-6`, круг 5): пустая версия держала бы язык.
    expect(await langOf(run.runId, 'es')).toMatchObject({
      status: 'failed',
      reason: 'NO_CHAPTERS_WRITTEN',
      bookVersionId: null,
      flaggedChunks: 1,
    });
    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(1);
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
    expect(translations().map((c) => c.model)).toEqual([TRANSLATOR]);
  });

  it('every provider refuses: paused NO_COMPLIANT_PROVIDER; resume with stageModels goes on that model', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    refuse = (name, body) =>
      name === 'translation' && [TRANSLATOR, MODEL].includes(body.model)
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
      reasonModels: [TRANSLATOR, MODEL],
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
      draftVersionId: null,
    });
    // Причина паузы строителя и его траты - в ходе запуска, без операции самого запуска (В1).
    expect(res.body.operations).toEqual([
      expect.objectContaining({
        id: builder.id,
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
        limitUsd: builder.limitUsd.toFixed(8),
        spentUsd: builder.spentUsd.toFixed(8),
      }),
    ]);
    // Операций запуска больше предела: ждущая языком старше всех, но в ответе остаётся.
    await prisma.llmOperation.createMany({
      data: Array.from({ length: 50 }, () => ({
        kind: 'dossier' as const,
        status: 'done' as const,
        limitUsd: '1',
        translationRunId: runId,
      })),
    });
    const crowded = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    const crowdedIds = (crowded.body as { operations: Array<{ id: string }> }).operations.map(
      (o) => o.id,
    );
    expect(crowdedIds).toHaveLength(51);
    expect(crowdedIds[0]).toBe(builder.id);
    await prisma.llmOperation.deleteMany({
      where: { translationRunId: runId, status: 'done', kind: 'dossier' },
    });
    // Досье чужого сравнения не привязано к запуску: видно по `blockedByOperationId`.
    await prisma.llmOperation.update({
      where: { id: builder.id },
      data: { translationRunId: null },
    });
    const foreign = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(foreign.body.operations.map((o: { id: string }) => o.id)).toEqual([builder.id]);
    // Операция другого запуска, на которую языки не ссылаются, в ответ не попадает.
    const other = await createRun(versionId, ['fr']);
    const unrelated = await prisma.llmOperation.create({
      data: {
        kind: 'dossier',
        status: 'paused',
        limitUsd: '1',
        translationRunId: other.runId,
      },
    });
    const isolated = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(isolated.body.operations.map((o: { id: string }) => o.id)).toEqual([builder.id]);
    expect(unrelated.translationRunId).toBe(other.runId);
  });

  it('the run limit left is lower than the dossier or the glossary limit: DOSSIER_LIMIT_TOO_LOW with the amount, nothing paid; resume clears it', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    // Лимит запуска меньше лимита операции досье (оценка × 1,5): досье не заводится вовсе.
    // Запуск уже потратил весь лимит - нужная сумма считается сверх потраченного.
    const { runId, opId } = await createRun(versionId, ['es'], '0.5');
    await prisma.llmOperation.update({ where: { id: opId }, data: { spentUsd: '0.5' } });

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
    const dossierLang = await langOf(runId, 'es');
    expect(dossierLang.reason).toBe(DOSSIER_LIMIT_TOO_LOW);
    expect(dossierLang.reasonUsd?.gt('0.5')).toBe(true);
    expect(
      await prisma.llmOperation.count({ where: { translationRunId: runId, kind: 'dossier' } }),
    ).toBe(0);
    const res = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(res.body.languages[0]).toMatchObject({
      stage: 'dossier',
      reason: DOSSIER_LIMIT_TOO_LOW,
      reasonUsd: dossierLang.reasonUsd?.toFixed(8),
      blockedByOperationId: null,
    });

    // Ровно этого лимита хватает: досье заводится, причина и лимит языка очищены.
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ limitUsd: dossierLang.reasonUsd?.toFixed(8) })
      .expect(200);
    await drain(
      async () =>
        (await prisma.llmOperation.count({
          where: { translationRunId: runId, kind: 'dossier' },
        })) > 0,
    );
    expect(
      await prisma.llmOperation.count({ where: { translationRunId: runId, kind: 'dossier' } }),
    ).toBe(1);
    expect(await langOf(runId, 'es')).toMatchObject({ reasonUsd: null, reasonModels: [] });
    expect((await langOf(runId, 'es')).reason).not.toBe(DOSSIER_LIMIT_TOO_LOW);
    await drain();

    // Досье готово: второй запуск на другой язык с крошечным лимитом встаёт на глоссарии.
    const second = await createRun(versionId, ['fr'], '0.00000001');
    await drain();
    const glossaryLang = await langOf(second.runId, 'fr');
    expect(glossaryLang).toMatchObject({ glossaryId: null, reason: DOSSIER_LIMIT_TOO_LOW });
    expect(glossaryLang.reasonUsd?.gt(0)).toBe(true);
    const glossary = await auth(http().get(`/admin/translation-runs/${second.runId}`)).expect(200);
    // Досье к запуску привязывается вместе с глоссарием: до него этап хода - `dossier`.
    expect(glossary.body.languages[0]).toMatchObject({
      reason: DOSSIER_LIMIT_TOO_LOW,
      reasonUsd: glossaryLang.reasonUsd?.toFixed(8),
    });
    expect(
      await prisma.llmOperation.count({
        where: { translationRunId: second.runId, kind: 'dossier' },
      }),
    ).toBe(0);
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
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    await startRun(versionId, { languages: ['es'] }).expect(202);
    await drain();
    await dropDrafts(bookId);
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
    const { bookId, versionId } = await englishBook([
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
          finalCheckUsd: string;
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
      translateModel: TRANSLATOR,
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
    // Сверка смысла, итоговая проверка и поля версии - своими полями и в сумме языка (решения
    // арбитра `F05 | F05-5`, `F05 | F05-6`).
    for (const l of before.languages) {
      expect(new Prisma.Decimal(l.checkUsd).isPositive()).toBe(true);
      expect(new Prisma.Decimal(l.finalCheckUsd).isPositive()).toBe(true);
      expect(new Prisma.Decimal(l.metadataUsd).isPositive()).toBe(true);
      expect(sum([l.splitUsd, l.translateUsd, l.checkUsd, l.finalCheckUsd, l.metadataUsd])).toBe(
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
    await dropDrafts(bookId);
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

  it('runs of the book filtered by version and by not finished: a running run older than eleven cancelled ones is still found (F05-7, /fix В1)', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const running = await startRun(versionId, { languages: ['fr'] }).expect(202);
    for (let i = 0; i < 11; i += 1) {
      const cancelled = await startRun(versionId, { languages: ['es'] }).expect(202);
      await auth(
        http().post(`/admin/translation-runs/${cancelled.body.id as string}/cancel`),
      ).expect(200);
    }

    const firstPage = await auth(http().get(`/admin/books/${bookId}/translation-runs`)).expect(200);
    expect(firstPage.body.items.map((r: { id: string }) => r.id)).not.toContain(running.body.id);

    const active = await auth(
      http()
        .get(`/admin/books/${bookId}/translation-runs`)
        .query({ bookVersionId: versionId, active: true }),
    ).expect(200);
    expect(active.body.items.map((r: { id: string }) => r.id)).toEqual([running.body.id]);
    expect(active.body.pagination.total).toBe(1);
    // На паузе запуск тоже незавершённый; не «true» и не «false» - 400, а не снятый фильтр.
    await auth(http().post(`/admin/translation-runs/${running.body.id as string}/pause`)).expect(
      200,
    );
    const paused = await auth(
      http()
        .get(`/admin/books/${bookId}/translation-runs`)
        .query({ bookVersionId: versionId, active: true }),
    ).expect(200);
    expect(paused.body.items.map((r: { id: string }) => r.id)).toEqual([running.body.id]);
    await auth(http().get(`/admin/books/${bookId}/translation-runs`).query({ active: '1' })).expect(
      400,
    );

    const latest = await auth(
      http()
        .get(`/admin/books/${bookId}/translation-runs`)
        .query({ bookVersionId: versionId, limit: 1 }),
    ).expect(200);
    expect(latest.body.pagination.total).toBe(12);
    expect(latest.body.items[0].operation.status).toBe('cancelled');

    const otherVersion = await auth(
      http()
        .get(`/admin/books/${bookId}/translation-runs`)
        .query({ bookVersionId: '00000000-0000-0000-0000-000000000000' }),
    ).expect(200);
    expect(otherVersion.body.items).toEqual([]);
    await auth(
      http().get(`/admin/books/${bookId}/translation-runs`).query({ bookVersionId: 'nope' }),
    ).expect(400);
  });

  it('history of runs: who, models by stage, cost equal to the report total, outcome by language - after cancel and after done (F05-8)', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const cancelled = await startRun(versionId, { languages: ['fr'] }).expect(202);
    await auth(http().post(`/admin/translation-runs/${cancelled.body.id as string}/cancel`)).expect(
      200,
    );
    // Отменённый - заметно раньше: порядок страниц не зависит от совпавшей миллисекунды.
    await prisma.translationRun.update({
      where: { id: cancelled.body.id as string },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    const finished = await startRun(versionId, { languages: ['es'] }).expect(202);
    await drain();
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: `f054-admin-${stamp}@test.com` },
      select: { id: true, email: true, name: true },
    });

    const res = await auth(
      http().get(`/admin/books/${bookId}/translation-runs`).query({ bookVersionId: versionId }),
    ).expect(200);

    // По номеру, а не по месту: запуски одной миллисекунды упорядочены по случайному id.
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    const done = items.find((r) => r.id === finished.body.id)!;
    const stopped = items.find((r) => r.id === cancelled.body.id)!;
    expect(done).toBeDefined();
    expect(stopped).toBeDefined();
    expect(done.createdBy).toEqual(admin);
    const report = await auth(
      http().get(`/admin/translation-runs/${finished.body.id as string}/report`),
    ).expect(200);
    // Стоимость - все операции запуска (досье, глоссарий), как итог отчёта (§7 п.8).
    expect(done.costUsd).toBe((report.body as TranslationRunReportDto).totalUsd);
    expect(
      new Prisma.Decimal(done.costUsd as string).gt(
        (done.operation as { spentUsd: string }).spentUsd,
      ),
    ).toBe(true);
    const draft = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { runId_language: { runId: finished.body.id as string, language: 'es' } },
    });
    expect(done.results).toEqual([
      {
        language: 'es',
        status: 'done',
        reason: null,
        reasonText: null,
        draftVersionId: draft.bookVersionId,
      },
    ]);
    expect(draft.bookVersionId).not.toBeNull();
    const stages = (
      done.models as Array<{ stage: string; model: string; fallbacks: string[] }>
    ).map((m) => m.stage);
    // Этапы - подпоследовательность конвейера в его порядке.
    expect(stages).toEqual(expect.arrayContaining(['split', 'translate']));
    expect(stages).not.toContain('dossier');
    expect(stages).toEqual(RUN_HISTORY_STAGES.filter((st) => stages.includes(st)));
    expect(stopped).toMatchObject({
      id: cancelled.body.id as string,
      createdBy: admin,
      results: [{ language: 'fr', status: 'cancelled', reasonText: null, draftVersionId: null }],
    });
    const stoppedReport = await auth(
      http().get(`/admin/translation-runs/${cancelled.body.id as string}/report`),
    ).expect(200);
    expect(stopped.costUsd).toBe((stoppedReport.body as TranslationRunReportDto).totalUsd);
    // Модель этапа - из снимка операции запуска, как её возьмёт шаг.
    const op = await opOf((done.operation as { id: string }).id);
    type SnapStage = { stage: string; model: string; fallbacks: string[] };
    const snap = (op.settingsSnapshot as { stages: SnapStage[] }).stages.find(
      (x) => x.stage === 'translate',
    )!;
    expect((done.models as SnapStage[]).find((m) => m.stage === 'translate')).toEqual({
      stage: 'translate',
      model: snap.model,
      fallbacks: snap.fallbacks,
    });

    // Удалённый автор - пусто, строка истории остаётся.
    await prisma.llmOperation.update({
      where: { id: (stopped.operation as { id: string }).id },
      data: { createdById: null },
    });
    const after = await auth(
      http().get(`/admin/books/${bookId}/translation-runs`).query({ bookVersionId: versionId }),
    ).expect(200);
    expect(after.body.items[1]).toMatchObject({ id: cancelled.body.id as string, createdBy: null });

    // Вторая страница: стоимость своего запуска, а не первого на странице 1.
    const second = await auth(
      http()
        .get(`/admin/books/${bookId}/translation-runs`)
        .query({ bookVersionId: versionId, page: 2, limit: 1 }),
    ).expect(200);
    expect(second.body.items.map((r: { id: string }) => r.id)).toEqual([cancelled.body.id]);
    expect(second.body.items[0].costUsd).toBe(
      (stoppedReport.body as TranslationRunReportDto).totalUsd,
    );

    // Книга без запусков - пустая страница, без группировки трат.
    const empty = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const none = await auth(http().get(`/admin/books/${empty.bookId}/translation-runs`)).expect(
      200,
    );
    expect(none.body.items).toEqual([]);
    expect(none.body.pagination.total).toBe(0);
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
      ['written', null, 500_000],
    ]);
    expect(chapters[0].length).toBeGreaterThan(500_000);
    // В черновике - только вторая глава: первой там нет (Р8).
    const draft = await prisma.chapter.findMany({
      where: { bookVersionId: lang.bookVersionId as string },
      select: { number: true },
    });
    expect(draft.map((c) => c.number)).toEqual([2]);
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
      status: 'written',
      flagReason: 'SEAM_REPEAT',
      seamIndex: 1,
      // Повтор кодом - флаг; ответы стыка и итоговой проверки без провала - записи, не флаги.
      findings: [
        { code: 'SEAM_REPEAT', seam: 1 },
        { code: 'SEAM_CHECKED', seam: 1, model: CHECKER, costUsd: '0.0001' },
        { code: 'FINAL_CHECKED', model: CHECKER, costUsd: '0.0001' },
      ],
    });
    expect(
      await prisma.chapter.count({ where: { bookVersionId: lang.bookVersionId as string } }),
    ).toBe(1);
    // Флаг главы виден в ходе, а не только в отчёте (`F05-7`, §2.3).
    const res = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(res.body.languages[0]).toMatchObject({ flaggedChapters: 1 });
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
      // Основная и запасная этапа (Р7 `F05 | F05-R`: запасная - та же модель, что умолчание перевода).
      reasonModels: [MODEL, TRANSLATOR],
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
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
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
    await dropDrafts(bookId);
    const after = await estimate();
    expect(after.upperBound).toBe(false);
    // Сверху - вход сверх промпта в размер ответов досье и глоссария: дороже, чем по готовым.
    expect(
      new Prisma.Decimal(before.languages[0].metadataUsd).greaterThan(
        after.languages[0].metadataUsd,
      ),
    ).toBe(true);
  });
  it('a language removed from the target languages mid-run: the language fails CREATE_REJECTED with the service text, the other language is not touched', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { rightsIntakeId } = await prisma.book.findUniqueOrThrow({
      where: { id: bookId },
      select: { rightsIntakeId: true },
    });
    await prisma.rightsIntake.update({
      where: { id: rightsIntakeId as string },
      data: { targetLanguages: ['en', 'fr'] },
    });
    const { runId } = await createRun(versionId, ['es', 'fr']);

    await drain();

    const es = await langOf(runId, 'es');
    expect(es).toMatchObject({ status: 'failed', reason: 'CREATE_REJECTED', bookVersionId: null });
    expect(es.reasonText).toContain('not in approved target languages');
    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'done', reasonText: null });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'fr' } })).toBe(1);
  });

  it('a version of the language created behind the run is a typed refusal: the language fails VERSION_EXISTS without a text', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'es',
        title: 'Hecha a mano',
        author: 'Autor',
        description: '',
        coverImageUrl: '',
        type: 'text',
        isFree: true,
        status: 'draft',
      },
    });

    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({
      status: 'failed',
      reason: 'VERSION_EXISTS',
      reasonText: null,
      bookVersionId: null,
    });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(1);
  });

  it('continue clears the refusal text together with the reason', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    await auth(http().post(`/admin/translation-runs/${runId}/pause`)).expect((r) => r.status < 300);
    const lang = await langOf(runId, 'es');
    await prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { reason: 'STEP_FAILED', reasonText: 'text' },
    });
    expect((await opOf(opId)).status).toBe('paused');

    await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(
      (r) => r.status < 300,
    );

    expect(await langOf(runId, 'es')).toMatchObject({ reason: null, reasonText: null });
  });

  it('the chapters go through the same rights staleness check as the manual ones; a step that fell after the first chapter is continued without duplicates', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const chapters = app.get(ChapterService);
    const stale = jest.spyOn(app.get(RightsContentHashService), 'checkVersionStaleness');
    const original = chapters.createLocked.bind(chapters) as ChapterService['createLocked'];
    let written = 0;
    jest.spyOn(chapters, 'createLocked').mockImplementation((...args) => {
      written += 1;
      if (written === 2) return Promise.reject(new Error('boom'));
      return original(...args);
    });
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();
    if ((await opOf(opId)).status === 'paused') {
      await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(
        (r) => r.status < 300,
      );
      await drain();
    }

    // Сбой сработал: вторая запись упала и была повторена - третья попытка записи.
    expect(written).toBeGreaterThanOrEqual(3);
    const lang = await langOf(runId, 'es');
    expect(lang.status).toBe('done');
    const draft = await prisma.chapter.findMany({
      where: { bookVersionId: lang.bookVersionId as string },
      orderBy: { number: 'asc' },
    });
    expect(draft.map((c) => c.number)).toEqual([1, 2]);
    // Каждая записанная глава - своя проверка свежести в транзакции записи (пятый аргумент).
    const own = stale.mock.calls.filter(
      (c) => c[0] === lang.bookVersionId && c[1] === 'CHAPTER_CREATED',
    );
    expect(own).toHaveLength(2);
    for (const call of own) expect(call[4]).toBeDefined();
    expect(
      await prisma.translationChapter.count({
        where: { runLanguageId: lang.id, status: 'written' },
      }),
    ).toBe(2);
  });

  it('a source chapter edited after the draft was created is flagged SOURCE_CHANGED and not written, the language goes on', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const drafts = app.get(TranslationDraftService);
    const create = drafts.createDraft.bind(drafts) as TranslationDraftService['createDraft'];
    jest.spyOn(drafts, 'createDraft').mockImplementation(async (...args) => {
      const created = await create(...args);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
        // Те же два блока: сборка из старых кусков прошла бы, главу ловит только отпечаток.
        data: { content: '<p>Anna leaves.</p><p>— Hello, Annie.</p>' },
      });
      return created;
    });
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    expect((await opOf(opId)).status).toBe('done');
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 1 });
    const rows = await prisma.translationChapter.findMany({
      where: { runLanguageId: lang.id },
      orderBy: { chapterNumber: 'asc' },
    });
    expect(rows.map((r) => [r.chapterNumber, r.status, r.flagReason])).toEqual([
      [1, 'written', null],
      [2, 'flagged', 'SOURCE_CHANGED'],
    ]);
    expect(
      await prisma.chapter.count({ where: { bookVersionId: lang.bookVersionId as string } }),
    ).toBe(1);
  });

  it('a chapter already in the draft is skipped without a hash and is not counted as a flag', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const drafts = app.get(TranslationDraftService);
    const create = drafts.createDraft.bind(drafts) as TranslationDraftService['createDraft'];
    jest.spyOn(drafts, 'createDraft').mockImplementation(async (...args) => {
      const created = await create(...args);
      if (created?.kind === 'created') {
        await prisma.chapter.create({
          data: {
            bookVersionId: created.versionId,
            number: 1,
            title: 'Manual',
            content: '<p>x</p>',
          },
        });
      }
      return created;
    });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 0 });
    const row = await prisma.translationChapter.findFirstOrThrow({
      where: { runLanguageId: lang.id },
    });
    expect(row).toMatchObject({ status: 'written', writtenHash: null });
    const manual = await prisma.chapter.findFirstOrThrow({
      where: { bookVersionId: lang.bookVersionId as string },
    });
    expect(row.chapterId).toBe(manual.id);
    expect(manual.title).toBe('Manual');
    // В отчёте глава с занятым номером - не записанная переводом (6c /fix круг 2, В5).
    const report = await auth(http().get(`/admin/translation-runs/${runId}/report`)).expect(200);
    expect(report.body.languages[0]).toMatchObject({
      writtenChapters: 0,
      takenChapters: [row.chapterNumber],
      notWrittenChapters: [],
    });
  });

  it('the author of the source is copied, not guessed by the translated name (Р16, Р22); a description with a forbidden tag is cleaned', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    // Имя из ответа этапа ("ES Author") есть среди переводов другого автора - подбор по имени
    // дал бы его; у исходника автора нет, значит у черновика его тоже нет.
    const other = await prisma.author.create({ data: {} });
    await prisma.authorTranslation.create({
      data: { authorId: other.id, language: 'es', slug: `f056-${stamp}`, name: 'ES Author' },
    });
    answer = (name, body) => {
      if (name !== 'metadata') return defaultAnswer(name, body);
      const base = metadataAnswerOf(body);
      return {
        ...base,
        description: base.description.map((d) => ({
          ...d,
          text: `${d.text} <script>alert(1)</script>`,
        })),
      };
    };
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const lang = await langOf(runId, 'es');
    const draft = await prisma.bookVersion.findUniqueOrThrow({
      where: { id: lang.bookVersionId as string },
    });
    expect(draft.authorId).toBeNull();
    expect(draft.description).not.toContain('script');
    expect(draft.bookId).toBe(bookId);
  });

  it('the author id of the source is copied as is', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const author = await prisma.author.create({ data: {} });
    await prisma.bookVersion.update({ where: { id: versionId }, data: { authorId: author.id } });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const lang = await langOf(runId, 'es');
    expect(
      (await prisma.bookVersion.findUniqueOrThrow({ where: { id: lang.bookVersionId as string } }))
        .authorId,
    ).toBe(author.id);
  });

  it('the dossier of a version made by the run is the run dossier without the stale flag (Р18); the source and a manual version are as before', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    await drain();
    const lang = await langOf(runId, 'es');
    const run = await prisma.translationRun.findUniqueOrThrow({ where: { id: runId } });
    const status = (id: string) =>
      auth(http().get(`/admin/versions/${id}/dossier`))
        .expect(200)
        .then((r) => r.body as { id: string; sourceVersionId: string; fresh: boolean });

    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
      data: { content: '<p>Edited after the run.</p>' },
    });

    expect(await status(lang.bookVersionId as string)).toMatchObject({
      id: run.dossierId,
      sourceVersionId: versionId,
      fresh: true,
    });
    expect(await status(versionId)).toMatchObject({ id: run.dossierId, fresh: false });
    const manual = await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'fr',
        title: 'A la main',
        author: 'Auteur',
        description: '',
        coverImageUrl: '',
        type: 'text',
        isFree: true,
        status: 'draft',
      },
    });
    expect(await status(manual.id)).toMatchObject({ id: run.dossierId, fresh: false });

    // Построить досье с версии перевода нельзя: у неё досье запуска, строить нечего и не за что.
    const dossiers = await prisma.bookDossier.count();
    const operations = await prisma.llmOperation.count();
    const refused = await auth(
      http()
        .post(`/admin/versions/${lang.bookVersionId as string}/dossier`)
        .send({}),
    ).expect(409);
    expect(refused.body.code).toBe('DOSSIER_OF_RUN');
    expect(await prisma.bookDossier.count()).toBe(dossiers);
    expect(await prisma.llmOperation.count()).toBe(operations);
    // С исходника - как прежде: устаревшее досье строится новым поколением.
    await auth(http().post(`/admin/versions/${versionId}/dossier`).send({})).expect(202);
  });
  it('the source edited while one language writes its draft: the language without a draft fails DOSSIER_STALE, the draft is finished (Р13 is not a dead end for it)', async () => {
    const { bookId, versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const drafts = app.get(TranslationDraftService);
    const create = drafts.createDraft.bind(drafts) as TranslationDraftService['createDraft'];
    let first: Language | null = null;
    jest.spyOn(drafts, 'createDraft').mockImplementation(async (lang, metadata) => {
      const created = await create(lang, metadata);
      if (first === null) {
        first = lang.language;
        await prisma.chapter.update({
          where: { bookVersionId_number: { bookVersionId: versionId, number: 2 } },
          data: { content: '<p>Anna leaves.</p><p>— Hello, Annie.</p>' },
        });
      }
      return created;
    });
    // Языки идут параллельно, шаг за шагом: fr отстаёт - каждый его кусок проходит сверку смысла
    // со второго раза, и к черновику он подходит после правки исходника, а не вместе с es.
    let frFailures = 0;
    answer = (name, body) => {
      if (
        name === 'check_semantic' &&
        JSON.stringify(body.messages).includes('FR ') &&
        frFailures < 3
      ) {
        frFailures += 1;
        return { verdict: 'fail', samples: [], omissions: [], nameFlags: [], remarks: ['Closer.'] };
      }
      return defaultAnswer(name, body);
    };
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);

    await drain();

    expect(first).toBe('es');
    const drafted = first as unknown as Language;
    const other: Language = drafted === 'es' ? 'fr' : 'es';
    expect((await opOf(opId)).status).toBe('done');
    expect(await langOf(runId, other)).toMatchObject({
      status: 'failed',
      reason: 'DOSSIER_STALE',
      bookVersionId: null,
    });
    const lang = await langOf(runId, drafted);
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 1 });
    expect(
      await prisma.chapter.count({ where: { bookVersionId: lang.bookVersionId as string } }),
    ).toBe(1);
    expect(await prisma.bookVersion.count({ where: { bookId, language: other } })).toBe(0);
  });

  it('continue after the source was edited: a language with a draft goes on, a language without one fails DOSSIER_STALE', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);
    // Состояние «на паузе: у es черновик, fr ещё переводит, исходник с тех пор правили» -
    // прямо в базе: отпечаток привязки не совпадает с текущим.
    const draft = await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'es',
        title: 'Borrador',
        author: 'Autor',
        description: '',
        coverImageUrl: '',
        type: 'text',
        isFree: true,
        status: 'draft',
      },
    });
    await prisma.translationRunLanguage.update({
      where: { id: (await langOf(runId, 'es')).id },
      data: { bookVersionId: draft.id, status: 'running' },
    });
    await prisma.translationRun.update({
      where: { id: runId },
      data: { dossierFingerprint: 'fingerprint-before-the-edit' },
    });
    await prisma.llmOperation.update({
      where: { id: opId },
      data: { status: 'paused', pauseReason: 'STEP_FAILED' },
    });
    // Пауза снимает ожидающие задачи операции - как настоящая (Р19).
    await prisma.llmTask.updateMany({
      where: { operationId: opId },
      data: { status: 'cancelled' },
    });

    await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(
      (r) => r.status < 300,
    );

    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'failed', reason: 'DOSSIER_STALE' });
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'running', reason: null });
    expect(await opOf(opId)).toMatchObject({ status: 'active', pauseReason: null });
    const queued = await prisma.llmTask.findMany({
      where: { operationId: opId, status: 'pending' },
      select: { payload: true },
    });
    // Задачи - всем открытым языкам, закрытый fr свою пропустит (`run`: язык не в работе).
    expect(
      queued.map((t) => (t.payload as { runLanguageId: string }).runLanguageId).sort(),
    ).toEqual([(await langOf(runId, 'es')).id, (await langOf(runId, 'fr')).id].sort());
    calls.length = 0;
    await drain();
    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'failed', reason: 'DOSSIER_STALE' });
    // Задача закрытого языка холостая: ни одного вызова модели и ни одной главы на fr.
    expect(calls.filter((c) => targetOf(c.body) === 'fr')).toHaveLength(0);
    expect(
      await prisma.translationChunk.count({
        where: { runLanguageId: (await langOf(runId, 'fr')).id },
      }),
    ).toBe(0);
  });

  it('continue when the source edit was undone before the resume transaction: nothing is closed, every open language goes on', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);
    const draft = await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'es',
        title: 'Borrador',
        author: 'Autor',
        description: '',
        coverImageUrl: '',
        type: 'text',
        isFree: true,
        status: 'draft',
      },
    });
    await prisma.translationRunLanguage.update({
      where: { id: (await langOf(runId, 'es')).id },
      data: { bookVersionId: draft.id, draftCreatedAt: new Date(), status: 'running' },
    });
    // Отпечаток привязки совпадает с текущим: правку исходника откатили.
    const [{ fingerprint }] = await prisma.$queryRaw<Array<{ fingerprint: string }>>`
      SELECT encode(sha256(convert_to(coalesce(
               string_agg(json_build_array(c."number", c."title", c."content")::text, E'\n'
                          ORDER BY c."number"), ''), 'UTF8')), 'hex') AS "fingerprint"
      FROM "Chapter" AS c WHERE c."bookVersionId" = ${versionId}`;
    await prisma.translationRun.update({
      where: { id: runId },
      data: { dossierFingerprint: fingerprint },
    });
    await prisma.llmOperation.update({
      where: { id: opId },
      data: { status: 'paused', pauseReason: 'STEP_FAILED' },
    });
    await prisma.llmTask.updateMany({
      where: { operationId: opId },
      data: { status: 'cancelled' },
    });

    await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(
      (r) => r.status < 300,
    );

    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'pending', reason: null });
    expect(await prisma.llmTask.count({ where: { operationId: opId, status: 'pending' } })).toBe(2);
  });

  it('continue after the source was edited: a deleted draft is DRAFT_DELETED, not a language without a draft', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);
    const draft = await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'es',
        title: 'Borrador',
        author: 'Autor',
        description: '',
        coverImageUrl: '',
        type: 'text',
        isFree: true,
        status: 'draft',
      },
    });
    await prisma.translationRunLanguage.update({
      where: { id: (await langOf(runId, 'es')).id },
      data: { bookVersionId: draft.id, draftCreatedAt: new Date(), status: 'running' },
    });
    // У fr черновик был и его удалили: метка есть, ссылки нет.
    await prisma.translationRunLanguage.update({
      where: { id: (await langOf(runId, 'fr')).id },
      data: { draftCreatedAt: new Date(), status: 'running' },
    });
    await prisma.translationRun.update({
      where: { id: runId },
      data: { dossierFingerprint: 'fingerprint-before-the-edit' },
    });
    await prisma.llmOperation.update({
      where: { id: opId },
      data: { status: 'paused', pauseReason: 'STEP_FAILED' },
    });
    await prisma.llmTask.updateMany({
      where: { operationId: opId },
      data: { status: 'cancelled' },
    });

    await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(
      (r) => r.status < 300,
    );

    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'failed', reason: 'DRAFT_DELETED' });
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'running', reason: null });
  });

  it('a draft deleted while its chapters are written: the language fails DRAFT_DELETED, no second draft', async () => {
    const { bookId, versionId } = await englishBook([
      { number: 1, title: 'One', content: SHORT },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const chapters = app.get(ChapterService);
    const original = chapters.createLocked.bind(chapters) as ChapterService['createLocked'];
    let deleted = false;
    jest.spyOn(chapters, 'createLocked').mockImplementation(async (id, data, after) => {
      const created = await original(id, data, after);
      if (!deleted) {
        deleted = true;
        await prisma.bookVersion.delete({ where: { id } });
      }
      return created;
    });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({
      status: 'failed',
      reason: 'DRAFT_DELETED',
      bookVersionId: null,
    });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
    // Ход не ссылается на удалённый черновик (`F05-7`).
    const res = await auth(http().get(`/admin/translation-runs/${runId}`)).expect(200);
    expect(res.body.languages[0]).toMatchObject({ reason: 'DRAFT_DELETED', draftVersionId: null });
  });

  it('a draft deleted before its first chapter: the language fails DRAFT_DELETED, no second draft', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const drafts = app.get(TranslationDraftService);
    const create = drafts.createDraft.bind(drafts) as TranslationDraftService['createDraft'];
    const createDraft = jest.spyOn(drafts, 'createDraft').mockImplementation(async (...args) => {
      const created = await create(...args);
      if (created?.kind === 'created') {
        await prisma.bookVersion.delete({ where: { id: created.versionId } });
      }
      return created;
    });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(await langOf(runId, 'es')).toMatchObject({
      status: 'failed',
      reason: 'DRAFT_DELETED',
      bookVersionId: null,
    });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });

  it('the source edited after the version fields, before the draft: the run pauses DOSSIER_STALE, no draft', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    // Правка - пока модель отвечает на поля версии: сверка шага `metadata` уже позади, сверка
    // перед черновиком - впереди.
    during = async (name) => {
      if (name !== 'metadata') return;
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
        data: { content: '<p>Anna leaves.</p><p>— Hello, Annie.</p>' },
      });
    };
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    expect(await langOf(runId, 'es')).toMatchObject({
      reason: 'DOSSIER_STALE',
      bookVersionId: null,
    });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });

  it('a long refusal text of the service is cut to 300 characters', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    jest
      .spyOn(app.get(BookVersionService), 'create')
      .mockRejectedValueOnce(new CreateFromRunRejectedError('CREATE_REJECTED', 'x'.repeat(400)));
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'failed', reason: 'CREATE_REJECTED' });
    expect(lang.reasonText).toBe('x'.repeat(300));
  });
  it('a draft that comes after the run already stopped on a stale source is rolled back (the pause came first)', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    await prisma.llmOperation.update({
      where: { id: opId },
      data: { status: 'paused', pauseReason: 'DOSSIER_STALE' },
    });
    const lang = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { runId_language: { runId, language: 'es' } },
      include: { run: true },
    });

    const created = await app.get(TranslationDraftService).createDraft(lang, {
      title: 'ES Book',
      author: 'ES Author',
      authorFromGlossary: false,
      description: '<p>ES Desc</p>',
      chapterTitles: [],
    });

    expect(created).toBeNull();
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
    expect(await langOf(runId, 'es')).toMatchObject({ bookVersionId: null, draftCreatedAt: null });
  });

  it('a draft deleted in the middle of a chapter write: the language fails DRAFT_DELETED, the run is not paused', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const chapters = app.get(ChapterService);
    const original = chapters.createLocked.bind(chapters) as ChapterService['createLocked'];
    jest.spyOn(chapters, 'createLocked').mockImplementationOnce(async (id, data, after) => {
      await prisma.bookVersion.delete({ where: { id } });
      return original(id, data, after);
    });
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({ status: 'failed', reason: 'DRAFT_DELETED' });
    expect((await opOf(opId)).status).toBe('done');
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });

  it('VERSION_EXISTS for the own draft (a repeated step after a lost lease) is not a failure', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const drafts = app.get(TranslationDraftService);
    const create = drafts.createDraft.bind(drafts) as TranslationDraftService['createDraft'];
    jest.spyOn(drafts, 'createDraft').mockImplementationOnce(async (lang, metadata) => {
      // Прошлый исполнитель создал черновик и ссылку, этот шаг видит язык без неё.
      await create(lang, metadata);
      return { kind: 'rejected', code: 'VERSION_EXISTS', text: null };
    });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', reason: null });
    expect(
      await prisma.chapter.count({ where: { bookVersionId: lang.bookVersionId as string } }),
    ).toBe(1);
  });

  it('a language cancelled while its draft waits for the lock gets no draft', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const drafts = app.get(TranslationDraftService);
    const create = drafts.createDraft.bind(drafts) as TranslationDraftService['createDraft'];
    jest.spyOn(drafts, 'createDraft').mockImplementationOnce(async (lang, metadata) => {
      await prisma.translationRunLanguage.update({
        where: { id: lang.id },
        data: { status: 'cancelled' },
      });
      return create(lang, metadata);
    });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({ status: 'cancelled', bookVersionId: null });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });
  /** Запуск на паузе (не тупик), исходник правили после привязки досье. */
  const pausedStaleRun = async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es', 'fr']);
    await prisma.translationRun.update({
      where: { id: runId },
      data: { dossierFingerprint: 'fingerprint-before-the-edit' },
    });
    await prisma.llmOperation.update({
      where: { id: opId },
      data: { status: 'paused', pauseReason: 'STEP_FAILED' },
    });
    await prisma.llmTask.updateMany({
      where: { operationId: opId },
      data: { status: 'cancelled' },
    });
    const draftOf = async (language: Language) => {
      const draft = await prisma.bookVersion.create({
        data: {
          bookId,
          language,
          title: 'Borrador',
          author: 'Autor',
          description: '',
          coverImageUrl: '',
          type: 'text',
          isFree: true,
          status: 'draft',
        },
      });
      await prisma.translationRunLanguage.update({
        where: { id: (await langOf(runId, language)).id },
        data: { bookVersionId: draft.id, draftCreatedAt: new Date(), status: 'running' },
      });
      return draft;
    };
    return { runId, opId, draftOf };
  };

  it('continue: a draft committed between the snapshot and the pause transaction is not left in the dead end (Р13)', async () => {
    const { runId, opId, draftOf } = await pausedStaleRun();
    // Снимок `resumeTasks` - черновиков нет; к транзакции смены причины черновик es уже есть.
    const repause = tasks.repauseOperation.bind(tasks) as LlmTaskService['repauseOperation'];
    jest.spyOn(tasks, 'repauseOperation').mockImplementationOnce(async (...args) => {
      await draftOf('es');
      return repause(...args);
    });

    await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(
      (r) => r.status < 300,
    );

    expect(await opOf(opId)).toMatchObject({ status: 'active', pauseReason: null });
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'running', reason: null });
    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'failed', reason: 'DOSSIER_STALE' });
  });

  it('continue: the only draft deleted between the snapshot and the resume transaction - no resume on the stale source', async () => {
    const { runId, opId, draftOf } = await pausedStaleRun();
    const draft = await draftOf('es');
    // Снимок `resumeTasks` видит черновик es; к транзакции «продолжить» его удалили.
    const resume = tasks.resumeOperation.bind(tasks) as LlmTaskService['resumeOperation'];
    jest.spyOn(tasks, 'resumeOperation').mockImplementationOnce(async (...args) => {
      await prisma.bookVersion.delete({ where: { id: draft.id } });
      return resume(...args);
    });

    const res = await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(409);

    expect(res.body.code).toBe('LLM_OPERATION_NOT_RESUMABLE');
    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'STEP_FAILED' });
    expect(await langOf(runId, 'fr')).toMatchObject({ status: 'pending' });
    // Следующее «продолжить» ставит тупик: черновика нет ни у кого.
    await auth(http().post(`/admin/translation-runs/${runId}/resume`)).expect(409);
    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'failed', reason: 'DRAFT_DELETED' });
  });
  /**
   * Держатель замка строки операции в своей транзакции: `underLock` - его запись до коммита.
   * Возвращает «отпустить» и pid держателя - по нему видно, что встречная транзакция ждёт замок.
   */
  const holdOperationRow = async (
    opId: string,
    underLock: (tx: Prisma.TransactionClient) => Promise<void> = () => Promise.resolve(),
  ) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (pid: number) => void = () => undefined;
    const inside = new Promise<number>((resolve) => {
      entered = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "LlmOperation" WHERE id = ${opId} FOR UPDATE`;
        await underLock(tx);
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        entered(row.pid);
        await held;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const pid = await inside;
    const waitsForHolder = async () => {
      for (let i = 0; i < 100; i++) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
        if (row.n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };
    return { holder, release: () => release(), waitsForHolder };
  };

  it('a draft waits for the operation row lock: a pause committed under it rolls the draft back', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    const lang = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { runId_language: { runId, language: 'es' } },
      include: { run: true },
    });
    // Пауза на устаревшем исходнике ставится под замком и ещё не закоммичена.
    const { holder, release, waitsForHolder } = await holdOperationRow(opId, async (tx) => {
      await tx.llmOperation.update({
        where: { id: opId },
        data: { status: 'paused', pauseReason: 'DOSSIER_STALE' },
      });
    });
    const creating = app.get(TranslationDraftService).createDraft(lang, {
      title: 'ES Book',
      author: 'ES Author',
      authorFromGlossary: false,
      description: '<p>ES Desc</p>',
      chapterTitles: [],
    });
    const waited = await waitsForHolder();
    release();
    await holder;

    expect(waited).toBe(true);
    expect(await creating).toBeNull();
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });
  it('a book whose only chapter is longer than the limit: the language fails NO_CHAPTERS_WRITTEN, no draft', async () => {
    const { bookId, versionId } = await englishBook([
      { number: 1, title: 'One', content: '<p>Big chapter.</p>' },
    ]);
    answer = (name, body) => {
      const base = defaultAnswer(name, body);
      if (name !== 'translation') return base;
      return { ...(base as object), blocks: [{ n: 1, text: 'x'.repeat(500_001) }] };
    };
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({
      status: 'failed',
      reason: 'NO_CHAPTERS_WRITTEN',
      bookVersionId: null,
    });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });

  it('a stale run language snapshot does not recreate a deleted draft', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    // Запуск дошёл до черновика - привязан к текущему исходнику (сверка под замком, `F05-6c`).
    await prisma.translationRun.update({
      where: { id: runId },
      data: { dossierFingerprint: await sourceFingerprint(prisma, versionId) },
    });
    // Снимок языка - до черновика; в базе черновик уже создавался и удалён.
    const snapshot = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { runId_language: { runId, language: 'es' } },
      include: { run: true },
    });
    await prisma.translationRunLanguage.update({
      where: { id: snapshot.id },
      data: { draftCreatedAt: new Date(), status: 'running' },
    });

    const created = await app.get(TranslationDraftService).createDraft(snapshot, {
      title: 'ES Book',
      author: 'ES Author',
      authorFromGlossary: false,
      description: '<p>ES Desc</p>',
      chapterTitles: [],
    });

    expect(created).toEqual({ kind: 'deleted' });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });
  /** Находки главы языка: порядок - как записаны. */
  const findingsOf = async (runLanguageId: string, chapterNumber: number) =>
    (
      await prisma.translationChapter.findUniqueOrThrow({
        where: { runLanguageId_chapterNumber: { runLanguageId, chapterNumber } },
      })
    ).findings as Array<Record<string, unknown>>;

  it('6c: a joint is read by a model of another family than both pieces; a broken joint flags the chapter with its number, the chapter is written', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    answer = (name, body) =>
      name === 'check_seam'
        ? { verdict: 'fail', problems: ['The sentence of block 20 is cut at the joint'] }
        : defaultAnswer(name, body);
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const seams = calls.filter((c) => c.name === 'check_seam');
    expect(seams.map((c) => c.model)).toEqual([CHECKER]);
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 1 });
    const chapter = await prisma.translationChapter.findFirstOrThrow({
      where: { runLanguageId: lang.id },
    });
    expect(chapter).toMatchObject({ status: 'written', flagReason: 'SEAM_BROKEN', seamIndex: 1 });
    expect(await findingsOf(lang.id, 1)).toContainEqual({
      code: 'SEAM_BROKEN',
      seam: 1,
      model: CHECKER,
      costUsd: '0.0001',
      problems: ['The sentence of block 20 is cut at the joint'],
    });
  });

  it('6c: the joint window is two blocks before and two after it, the source and the translation', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    await createRun(versionId, ['es']);

    await drain();

    const [seam] = calls.filter((c) => c.name === 'check_seam');
    const pieces = translations().map((c) => blocksOf(c.body).map((b) => b.n));
    const joint = pieces[0][pieces[0].length - 1];
    const user = seam.body.messages[1].content;
    for (const n of [joint - 1, joint, joint + 1, joint + 2]) {
      expect(user).toContain(` ${n - 1} w0`);
    }
    expect(user).not.toContain(` ${joint - 3} w0`);
    expect(user).not.toContain(` ${joint + 2} w0`);
    expect(user).toContain('<<<TRANSLATION_AFTER\nES ');
  });

  it('6c: pieces of a joint by two families: the checker is of a third family, not of either piece', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const pending = async () =>
      (await prisma.translationChapter.count({
        where: { runLanguageId: lang.id, status: 'pending' },
      })) > 0;
    await drain(pending);
    // Второй кусок перевела модель семейства основного проверяющего (переход по 429).
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id, chunkIndex: 1 },
      data: { model: 'deepseek/deepseek-v3' },
    });

    await drain();

    expect(calls.filter((c) => c.name === 'check_seam').map((c) => c.model)).toEqual([CHECKER_ALT]);
  });

  it('6c: a joint answer saved before the step is recorded is not paid again', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const saved = async () =>
      (
        await prisma.translationChapter.findMany({
          where: { runLanguageId: lang.id, status: 'pending' },
        })
      ).some((c) => Array.isArray(c.findings) && c.findings.length > 0);
    await drain(saved);
    expect(calls.filter((c) => c.name === 'check_seam')).toHaveLength(1);

    await prisma.llmTask.updateMany({
      where: {
        operation: { translationRun: { id: runId } },
        status: { in: ['pending', 'running'] },
      },
      data: { status: 'running', ownerToken: 'dead', leaseUntil: new Date(Date.now() - 1000) },
    });
    await drain();

    expect(calls.filter((c) => c.name === 'check_seam')).toHaveLength(1);
    expect(await findingsOf(lang.id, 1)).toContainEqual({
      code: 'SEAM_CHECKED',
      seam: 1,
      model: CHECKER,
      costUsd: '0.0001',
    });
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
  });

  it('6c: final check - the source spelling of a glossary name left in the translation and a remark of the model on a block flag the chapter; the chapter is written', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    keepNames = true;
    answer = (name, body) =>
      name === 'final_check'
        ? {
            verdict: 'fail',
            issues: [
              { block: 2, problem: 'The greeting lost its name' },
              { block: 7, problem: 'A block the model never saw' },
            ],
          }
        : defaultAnswer(name, body);
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const finals = calls.filter((c) => c.name === 'final_check');
    expect(finals.map((c) => c.model)).toEqual([CHECKER]);
    expect(finals[0].body.messages[1].content).toContain('[2] ES — Hello, Annie.');
    const lang = await langOf(runId, 'es');
    // Глава одна: флаг считается один раз, находок - две.
    expect(lang).toMatchObject({ status: 'done', flaggedChapters: 1 });
    expect(await findingsOf(lang.id, 1)).toEqual([
      {
        code: 'GLOSSARY_SOURCE_FORM',
        key: 'anna',
        form: 'Anna',
        target: 'Ana',
        fragment: 'ES Anna arrives. ES — Hello, Annie.',
      },
      {
        code: 'FINAL_CHECK_FAIL',
        block: 2,
        issue: 'The greeting lost its name',
        model: CHECKER,
        costUsd: '0.0001',
      },
    ]);
    const chapter = await prisma.translationChapter.findFirstOrThrow({
      where: { runLanguageId: lang.id },
    });
    expect(chapter).toMatchObject({ status: 'written', flagReason: 'GLOSSARY_SOURCE_FORM' });
    expect(lang.finalCheck).toEqual({
      code: { missing: [] },
      chapters: [{ number: 1, outcome: 'fail', model: CHECKER, costUsd: '0.0001' }],
      done: true,
    });
    // Итоговая проверка - до полей версии (решение арбитра, В6).
    const names = calls.map((c) => c.name);
    expect(names.indexOf('final_check')).toBeLessThan(names.indexOf('metadata'));
  });

  it('6c: a final check answer saved before the step is recorded is not paid again', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const saved = async () =>
      ((await langOf(runId, 'es')).finalCheck as { chapters?: unknown[] } | null)?.chapters
        ?.length === 1;
    await drain(saved);
    expect(calls.filter((c) => c.name === 'final_check')).toHaveLength(1);

    await prisma.llmTask.updateMany({
      where: {
        operation: { translationRun: { id: runId } },
        status: { in: ['pending', 'running'] },
      },
      data: { status: 'running', ownerToken: 'dead', leaseUntil: new Date(Date.now() - 1000) },
    });
    await drain();

    expect(calls.filter((c) => c.name === 'final_check')).toHaveLength(1);
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
  });

  it('6c: a run language whose version fields started before the final check existed does not catch up on it', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    // Запуск шёл во время выката: язык дошёл до `metadata` старым кодом, `finalCheck` пуст.
    const assembled = async () =>
      (await prisma.translationChapter.count({ where: { runLanguageId: lang.id } })) > 0;
    await drain(assembled);
    await prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { metadata: { attempts: [], result: null } },
    });

    await drain();

    expect(calls.filter((c) => c.name === 'final_check')).toHaveLength(0);
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done', finalCheck: null });
    const report = await auth(http().get(`/admin/translation-runs/${runId}/report`)).expect(200);
    expect(report.body.languages[0].finalCheck).toEqual({
      status: 'skipped',
      missingChapters: [],
      chaptersChecked: 0,
    });
  });

  it('6c: every provider of the final check refuses: paused with its models; resume with stageModels.final_check of another family goes on, of the same family is refused', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    // Отказывают обе модели умолчания: основная и запасная третьего семейства.
    refuse = (name, body) =>
      name === 'final_check' && body.model !== Z_CHECKER
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
      reason: 'FINAL_CHECK_NO_COMPLIANT_PROVIDER',
      reasonModels: [CHECKER, CHECKER_ALT],
    });
    const same = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { final_check: TRANSLATOR } })
      .expect(409);
    expect(same.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { final_check: Z_CHECKER } })
      .expect(200);
    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
    expect(calls.filter((c) => c.name === 'final_check').at(-1)?.model).toBe(Z_CHECKER);
  });

  it('6c: no final check model of another family than the translate model: estimate and start refuse 409; otherwise the final check is in the estimate total', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: LONG },
      { number: 2, title: 'Two', content: SHORT },
    ]);
    const estimate = (query: Record<string, string>) =>
      auth(http().get(`/admin/versions/${versionId}/translation-runs/estimate`).query(query));
    await withStages([{ stage: 'final_check', model: TRANSLATOR, fallbacks: [] }], async () => {
      const refused = await estimate({ languages: 'es' }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });
      const start = await startRun(versionId, { languages: ['es'] }).expect(409);
      expect(start.body).toMatchObject({ code: 'CHECK_MODEL_SAME_FAMILY' });
    });
    const ok = await estimate({ languages: 'es' }).expect(200);
    const [es] = ok.body.languages as Array<Record<string, string>>;
    const money = (v: string) => new Prisma.Decimal(v);
    expect(money(es.finalCheckUsd).isPositive()).toBe(true);
    expect(
      money(es.splitUsd)
        .add(es.translateUsd)
        .add(es.checkUsd)
        .add(es.finalCheckUsd)
        .add(es.metadataUsd)
        .toFixed(8),
    ).toBe(es.totalUsd);
  });

  it('6c: the report - pieces, retries, piece and chapter flags, chapters not in the draft, the draft; cost by stage and model sums to the spent of every run operation to the cent', async () => {
    const { versionId } = await englishBook([
      { number: 1, title: 'One', content: '<p>Big chapter.</p>' },
      { number: 2, title: 'Two', content: LONG },
    ]);
    const prices: Record<string, number> = {
      dossier_part: 0.00011,
      dossier: 0.00013,
      glossary: 0.00017,
      translation: 0.00019,
      check_semantic: 0.00023,
      check_language_jev: 0.00041,
      check_seam: 0.00029,
      final_check: 0.00031,
      metadata: 0.00037,
    };
    costOf = (name) => prices[name] ?? 0;
    let failed = false;
    answer = (name, body) => {
      const base = defaultAnswer(name, body);
      if (name === 'check_semantic' && !failed) {
        // Первый кусок проверки - провал смысла: перевод заново с замечаниями (повтор).
        failed = true;
        return { ...(base as object), verdict: 'fail' };
      }
      if (name !== 'translation' || !body.messages[1].content.includes('Big chapter')) return base;
      return { ...(base as object), blocks: [{ n: 1, text: 'x'.repeat(500_001) }] };
    };
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    const response = await auth(http().get(`/admin/translation-runs/${runId}/report`)).expect(200);
    const report = response.body as TranslationRunReportDto;
    const lang = await langOf(runId, 'es');
    expect(report).toMatchObject({ id: runId, bookVersionId: versionId });
    expect(report.languages).toHaveLength(1);
    const [es] = report.languages;
    expect(es).toMatchObject({
      language: 'es',
      status: 'done',
      draftVersionId: lang.bookVersionId,
      flaggedChapters: lang.flaggedChapters,
      authorFromGlossary: false,
      notWrittenChapters: [1],
      writtenChapters: 1,
      // Глава 1 с флагом Р8 - в `notWrittenChapters`, пропавшей она не считается.
      finalCheck: { status: 'done', missingChapters: [], chaptersChecked: 1 },
    });
    expect(es.chunks.total).toBe(
      await prisma.translationChunk.count({ where: { runLanguageId: lang.id } }),
    );
    const chunkRows = await prisma.translationChunk.findMany({
      where: { runLanguageId: lang.id },
      select: { attempts: true },
    });
    const retries = chunkRows.reduce((sum, c) => sum + Math.max(c.attempts - 1, 0), 0);
    expect(retries).toBeGreaterThan(0);
    expect(es.chunks.retries).toBe(retries);
    expect(es.chapters.map((c) => [c.number, c.status])).toEqual([
      [1, 'flagged'],
      [2, 'written'],
    ]);
    expect(es.chapters[0]).toMatchObject({ flagReason: 'CHAPTER_TOO_LONG', lengthLimit: 500_000 });
    // Находки наружу - без стоимости ответа: деньги - в `costs`.
    expect(es.chapters[1].findings.find((f) => f.code === 'SEAM_CHECKED')).toEqual({
      code: 'SEAM_CHECKED',
      seam: 1,
      model: CHECKER,
    });

    const spent = await prisma.llmOperation.aggregate({
      where: { translationRunId: runId },
      _sum: { spentUsd: true },
    });
    const paid = await prisma.llmCall.aggregate({
      where: { operation: { translationRunId: runId } },
      _sum: { costUsd: true },
    });
    expect(report.totalUsd).toBe((spent._sum.spentUsd as Prisma.Decimal).toFixed(8));
    expect(report.totalUsd).toBe((paid._sum.costUsd as Prisma.Decimal).toFixed(8));
    const rows = report.costs as Array<{ stage: string; model: string | null; costUsd: string }>;
    expect(rows.reduce((sum, r) => sum.add(r.costUsd), new Prisma.Decimal(0)).toFixed(8)).toBe(
      report.totalUsd,
    );
    // Досье и глоссарий запуска - своими операциями, но в отчёте запуска.
    expect(new Set(rows.map((r) => r.stage))).toEqual(
      new Set([
        'dossier',
        'glossary',
        'split',
        'translate',
        'check_language_jev',
        'check_semantic',
        'final_check',
        'metadata',
      ]),
    );
    expect(rows.find((r) => r.stage === 'final_check')).toMatchObject({ model: CHECKER });
    expect(report.inFlight).toEqual({ calls: 0, reservedUsd: '0.00000000' });

    await auth(
      http().get(`/admin/translation-runs/00000000-0000-0000-0000-000000000000/report`),
    ).expect(404);
  });

  it('6c: the source title edited after the version fields, before the draft lock: the fields are translated again, the draft has the new title', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const versions = app.get(BookVersionService);
    // Правка - после последней сверки шага, до замка черновика.
    jest
      .spyOn(versions, 'create')
      .mockImplementationOnce(async (...args: Parameters<BookVersionService['create']>) => {
        await prisma.bookVersion.update({
          where: { id: versionId },
          data: { title: 'Book en, revised' },
        });
        // Разовая подмена уже снята: этот вызов идёт в настоящий метод.
        return versions.create(...args);
      });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(2);
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ status: 'done' });
    expect(lang.metadata).toMatchObject({
      attempts: [{ outcome: 'pass' }, { outcome: 'pass' }],
      result: { title: 'ES Book en, revised' },
    });
    const drafts = await prisma.bookVersion.findMany({ where: { bookId, language: 'es' } });
    expect(drafts.map((d) => d.title)).toEqual(['ES Book en, revised']);
  });

  it('6c: the source chapters edited after the last check of the step, before the draft lock: DOSSIER_STALE, no draft', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const versions = app.get(BookVersionService);
    jest
      .spyOn(versions, 'create')
      .mockImplementationOnce(async (...args: Parameters<BookVersionService['create']>) => {
        await prisma.chapter.update({
          where: { bookVersionId_number: { bookVersionId: versionId, number: 1 } },
          data: { content: '<p>Anna leaves.</p>' },
        });
        // Разовая подмена уже снята: этот вызов идёт в настоящий метод.
        return versions.create(...args);
      });
    const { runId, opId } = await createRun(versionId, ['es']);

    await drain();

    expect(await opOf(opId)).toMatchObject({ status: 'paused', pauseReason: 'DOSSIER_STALE' });
    expect(await langOf(runId, 'es')).toMatchObject({
      reason: 'DOSSIER_STALE',
      bookVersionId: null,
    });
    expect(await prisma.bookVersion.count({ where: { bookId, language: 'es' } })).toBe(0);
  });

  it('6c: a chapter title missing from the version fields answer is written empty with a TITLE_MISSING flag', async () => {
    const { versionId } = await englishBook([
      // Без имён глоссария: иных флагов у глав нет, флаг названия - первый.
      { number: 1, title: 'One', content: '<p>Bob arrives.</p>' },
      { number: 2, title: '', content: '<p>Bob stays.</p>' },
    ]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const drafted = async () => (await langOf(runId, 'es')).bookVersionId !== null;
    await drain(drafted);
    // Ответ `metadata` без названий глав: путь главы, появившейся после этапа.
    const state = (await langOf(runId, 'es')).metadata as { result: Record<string, unknown> };
    await prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: {
        metadata: {
          ...state,
          result: { ...state.result, chapterTitles: [] },
        } as Prisma.InputJsonValue,
      },
    });
    const before = (await langOf(runId, 'es')).flaggedChapters;

    await drain();

    const done = await langOf(runId, 'es');
    const titles = await prisma.chapter.findMany({
      where: { bookVersionId: done.bookVersionId as string },
      select: { number: true, title: true },
      orderBy: { number: 'asc' },
    });
    expect(titles).toEqual([
      { number: 1, title: '' },
      { number: 2, title: '' },
    ]);
    // Глава 1 - с названием у исходника: находка; глава 2 без названия - без неё.
    expect(await findingsOf(lang.id, 1)).toContainEqual({ code: 'TITLE_MISSING' });
    expect(await findingsOf(lang.id, 2)).not.toContainEqual({ code: 'TITLE_MISSING' });
    const written = await prisma.translationChapter.findMany({
      where: { runLanguageId: lang.id },
      orderBy: { chapterNumber: 'asc' },
    });
    expect(written.map((c) => [c.status, c.flagReason])).toEqual([
      ['written', 'TITLE_MISSING'],
      ['written', null],
    ]);
    expect(done.flaggedChapters).toBe(before + 1);
  });
  it('6c: a piece of a joint translated without a recorded model: independence cannot be told - SEAM_NOT_INDEPENDENT without a call', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const pending = async () =>
      (await prisma.translationChapter.count({
        where: { runLanguageId: lang.id, status: 'pending' },
      })) > 0;
    await drain(pending);
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id, chunkIndex: 1 },
      data: { model: null },
    });

    await drain();

    expect(calls.filter((c) => c.name === 'check_seam')).toHaveLength(0);
    expect(await findingsOf(lang.id, 1)).toContainEqual({ code: 'SEAM_NOT_INDEPENDENT', seam: 1 });
    const chapter = await prisma.translationChapter.findFirstOrThrow({
      where: { runLanguageId: lang.id },
    });
    expect(chapter).toMatchObject({
      status: 'written',
      flagReason: 'SEAM_NOT_INDEPENDENT',
      seamIndex: 1,
    });
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done', flaggedChapters: 1 });
  });

  it('6c: a chapter translated by the family of the final check model goes to its fallback of a third family', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const assembled = async () =>
      (await prisma.translationChapter.count({ where: { runLanguageId: lang.id } })) > 0;
    await drain(assembled);
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id },
      data: { model: 'deepseek/deepseek-v3' },
    });

    await drain();

    expect(calls.filter((c) => c.name === 'final_check').map((c) => c.model)).toEqual([
      CHECKER_ALT,
    ]);
  });

  it('6c: a chapter translated by the families of both final check models: FINAL_NOT_INDEPENDENT without a call, the chapter is written', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const assembled = async () =>
      (await prisma.translationChapter.count({
        where: { runLanguageId: lang.id, status: 'assembled' },
      })) > 0;
    await drain(assembled);
    // Куски главы перевели модели семейств основной и запасной итоговой проверки.
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id, chunkIndex: 0 },
      data: { model: 'deepseek/deepseek-v3' },
    });
    await prisma.translationChunk.updateMany({
      where: { runLanguageId: lang.id, chunkIndex: 1 },
      data: { model: 'z-ai/glm-4' },
    });

    await drain();

    expect(calls.filter((c) => c.name === 'final_check')).toHaveLength(0);
    expect(await findingsOf(lang.id, 1)).toContainEqual({ code: 'FINAL_NOT_INDEPENDENT' });
    const done = await langOf(runId, 'es');
    expect(done).toMatchObject({ status: 'done', flaggedChapters: 1 });
    expect(done.finalCheck).toMatchObject({
      chapters: [{ number: 1, outcome: 'not_independent', model: '' }],
      done: true,
    });
  });

  it('6c: the final check stage disabled mid-run: FINAL_CHECK_UNAVAILABLE on the chapter, the language goes on', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const assembled = async () =>
      (await prisma.translationChapter.count({ where: { runLanguageId: lang.id } })) > 0;
    await drain(assembled);

    await withStages(
      [{ stage: 'final_check', model: CHECKER, fallbacks: [], enabled: false }],
      async () => {
        await drain();
      },
    );

    expect(calls.filter((c) => c.name === 'final_check')).toHaveLength(0);
    expect(await findingsOf(lang.id, 1)).toEqual([{ code: 'FINAL_CHECK_UNAVAILABLE' }]);
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done', flaggedChapters: 1 });
  });

  it('6c: a final check state without the code result (a broken write) is redone, not a step that never moves', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const assembled = async () =>
      (await prisma.translationChapter.count({ where: { runLanguageId: lang.id } })) > 0;
    await drain(assembled);
    await prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { finalCheck: { code: null, chapters: [], done: false } },
    });

    await drain();

    const done = await langOf(runId, 'es');
    expect(done).toMatchObject({ status: 'done' });
    expect(done.finalCheck).toMatchObject({ code: { missing: [] }, done: true });
    expect(calls.filter((c) => c.name === 'final_check')).toHaveLength(1);
  });
  it('6c: a translator of the deepseek or glm family still has a final check of another family: estimate passes', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    for (const translateModel of [CHECKER, CHECKER_ALT]) {
      const ok = await auth(
        http()
          .get(`/admin/versions/${versionId}/translation-runs/estimate`)
          .query({ languages: 'es', translateModel }),
      ).expect(200);
      const [es] = ok.body.languages as Array<Record<string, string>>;
      expect(new Prisma.Decimal(es.finalCheckUsd).isPositive()).toBe(true);
    }
  });

  it('6c: the source author edited after the version fields, before the draft lock: the fields are translated again', async () => {
    const { bookId, versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const versions = app.get(BookVersionService);
    jest
      .spyOn(versions, 'create')
      .mockImplementationOnce(async (...args: Parameters<BookVersionService['create']>) => {
        await prisma.bookVersion.update({
          where: { id: versionId },
          data: { author: 'Author, revised' },
        });
        // Разовая подмена уже снята: этот вызов идёт в настоящий метод.
        return versions.create(...args);
      });
    const { runId } = await createRun(versionId, ['es']);

    await drain();

    expect(calls.filter((c) => c.name === 'metadata')).toHaveLength(2);
    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
    const drafts = await prisma.bookVersion.findMany({ where: { bookId, language: 'es' } });
    expect(drafts.map((d) => d.author)).toEqual(['ES Author, revised']);
  });

  it('6c: the report of a language still translating: the final check is pending, not skipped', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const lang = await langOf(runId, 'es');
    const translated = async () =>
      (await prisma.translationChunk.count({
        where: { runLanguageId: lang.id, status: 'translated' },
      })) > 0;
    await drain(translated);

    const report = await auth(http().get(`/admin/translation-runs/${runId}/report`)).expect(200);

    expect(report.body.languages[0].finalCheck).toEqual({
      status: 'pending',
      missingChapters: [],
      chaptersChecked: 0,
    });
  });

  it('6c: every provider of the joint check refuses: the chapter waits pending, paused with the check models; resume with stageModels.check_semantic goes on', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: LONG }]);
    const { runId, opId } = await createRun(versionId, ['es']);
    refuse = (name, body) =>
      name === 'check_seam' && body.model !== Z_CHECKER
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
    const lang = await langOf(runId, 'es');
    expect(lang).toMatchObject({ reason: 'CHECK_NO_COMPLIANT_PROVIDER' });
    expect(
      await prisma.translationChapter.findFirstOrThrow({ where: { runLanguageId: lang.id } }),
    ).toMatchObject({ status: 'pending', findings: [] });
    await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({ stageModels: { check_semantic: Z_CHECKER } })
      .expect(200);
    await drain();

    expect(await langOf(runId, 'es')).toMatchObject({ status: 'done' });
    expect(await findingsOf(lang.id, 1)).toContainEqual({
      code: 'SEAM_CHECKED',
      seam: 1,
      model: Z_CHECKER,
      costUsd: '0.0001',
    });
  });
  it('6c: the report of a language cancelled in the middle of its final check: skipped, not in progress', async () => {
    const { versionId } = await englishBook([{ number: 1, title: 'One', content: SHORT }]);
    const { runId } = await createRun(versionId, ['es']);
    const coded = async () =>
      ((await langOf(runId, 'es')).finalCheck as { code?: unknown } | null)?.code !== undefined;
    await drain(coded);
    await auth(http().post(`/admin/translation-runs/${runId}/cancel`)).expect(200);

    const report = await auth(http().get(`/admin/translation-runs/${runId}/report`)).expect(200);

    expect(report.body.languages[0]).toMatchObject({
      status: 'cancelled',
      finalCheck: { status: 'skipped' },
    });
  });
});
