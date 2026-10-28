/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, LlmTask, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmTaskService } from '../src/modules/llm-worker/llm-task.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { LlmTaskLeaseLostError } from '../src/modules/llm-worker/llm-worker.errors';
import { DossierService } from '../src/modules/translation/dossier/dossier.service';
import {
  DOSSIER_TASK_KIND,
  GLOSSARY_TASK_KIND,
} from '../src/modules/translation/dossier/dossier.constants';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-2: исходник по D8, досье и глоссарий. Построение идёт настоящим исполнителем на базе:
 * его таймер в e2e не заведён (ключа на старте нет, Р25), проходы зовутся руками. Внешний
 * `fetch` подменён всегда: ответ модели выбирается по имени схемы ответа.
 */
describe('Translation source and dossier (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const ALT = 'z/alt-model';
  /** Модель с крошечным контекстом: сводка досье в неё не влезает. */
  const TINY = 'z/tiny-context';
  /** Модель с огромным контекстом: потолок по контексту выше суммы ответов кусков. */
  const HUGE = 'z/huge-context';
  /** Контекст, в который сводка книги на 250 глав не влезает целиком, а группа глав - влезает (F05-Rb). */
  const SMALL = 'z/small-context';
  /**
   * Вход сводки ~24 тыс. символов ((12 620 - 2 000) × 2,26 при `maxTokens` 2 000 у `setGroupModel`):
   * размеры групп в тестах уровней считаются от него.
   */
  const GROUP = 'z/group-context';
  /**
   * Тот же вход ~24 тыс. символов ((26 620 - 16 000) × 2,26), но при `maxTokens` 16 000: выше
   * уровня 0 в вызов заведомо не влезают два ответа группы (`F05-12`, пересмотр Р3).
   */
  const NARROW = 'z/narrow-context';
  const MODELS = {
    data: [
      ...[MODEL, ALT].map((id) => ({
        id,
        name: id,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['structured_outputs'],
      })),
      ...(
        [
          [TINY, 1000],
          [HUGE, 100_000_000],
          [SMALL, 30_000],
          [GROUP, 12_620],
          [NARROW, 26_620],
        ] as const
      ).map(([id, context]) => ({
        id,
        name: id,
        context_length: context,
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['structured_outputs'],
      })),
    ],
  };

  const PART = {
    summary: 'Something happens.',
    characters: [
      {
        name: 'Anna',
        variants: ['Annie'],
        gender: 'female',
        whoIs: 'heroine',
        address: [],
        relations: [],
      },
    ],
    entities: [{ name: 'Town', kind: 'place', whatIs: 'a town' }],
    events: [{ event: 'Anna arrives', orderNote: '' }],
    voice: { notes: 'calm', devices: [] },
    motifs: ['rain'],
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
    entities: [{ key: 'town', name: 'Town', kind: 'place', whatIs: 'a town', firstChapter: 1 }],
    narration: { person: 'third', form: 'prose', notes: '' },
    setting: { place: 'Town', time: '1900s' },
    structure: { parts: [], notes: '' },
    chronology: [{ event: 'Anna arrives', chapter: 1, orderNote: '' }],
    chapters: [
      { number: 1, title: 'One', summary: 'Arrival.' },
      { number: 2, title: 'Two', summary: 'Departure.' },
    ],
    summaryPlan: [{ number: 1, title: 'Chapter 1. One', chapters: [1], why: 'one scene' }],
    voice: { pace: 'slow', sentenceLength: 'long', lexicon: 'plain', irony: 'none', devices: [] },
    motifs: [{ image: 'rain', chapters: [1, 2] }],
  };
  const GLOSSARY = {
    entries: [
      {
        key: 'anna',
        source: 'Anna',
        target: 'Anne',
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
  let tasks: LlmTaskService;
  let dossiers: DossierService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();
  const slugs: string[] = [];

  /** Ответ модели по имени схемы; `null` - ответ по умолчанию. */
  let answer: (name: string, body: ChatBody) => unknown;
  const calls: Array<{ name: string; model: string; body: ChatBody }> = [];

  interface ChatBody {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { json_schema?: { name?: string } };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  /** Сводка отвечает главами из запроса: досье покрывает все главы исходника. */
  const dossierFor = (body?: ChatBody) => {
    const user = body?.messages[1]?.content ?? '';
    const match = /^Chapters: (\[.*?\])\n\n/s.exec(user);
    const chapters = match
      ? (JSON.parse(match[1]) as Array<{ number: number; title: string }>)
      : DOSSIER.chapters;
    // Ссылки на главы - только на главы запроса: у группы (F05-Rb) это не первые главы книги.
    const first = chapters[0]?.number ?? 1;
    return {
      ...DOSSIER,
      characters: DOSSIER.characters.map((c) => ({ ...c, firstChapter: first })),
      entities: DOSSIER.entities.map((e) => ({ ...e, firstChapter: first })),
      chronology: DOSSIER.chronology.map((e) => ({ ...e, chapter: first })),
      chapters: chapters.map((c) => ({ number: c.number, title: c.title, summary: 'S.' })),
      summaryPlan: DOSSIER.summaryPlan.map((p) => ({ ...p, chapters: [first] })),
      motifs: [{ image: 'rain', chapters: [first] }],
    };
  };

  const defaultAnswer = (name: string, body?: ChatBody): unknown =>
    name === 'dossier_part' ? PART : name === 'dossier' ? dossierFor(body) : GLOSSARY;

  const callsOf = (name: string) => calls.filter((c) => c.name === name);

  const register = async (email: string): Promise<void> => {
    await request(httpServerOf(app))
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
  };

  const login = async (email: string): Promise<string> => {
    const res = await request(httpServerOf(app))
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);

  /** Книга с версиями: `versions` - язык → поле «язык оригинала» и главы. */
  const book = async (
    versions: Array<{
      language: Language;
      originalLanguage: string | null;
      chapters?: Array<{ number: number; title: string; content: string }>;
    }>,
  ) => {
    const slug = `f052-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book: created } = await createBookWithRights(prisma, slug);
    const ids: Partial<Record<Language, string>> = {};
    for (const v of versions) {
      const row = await prisma.bookVersion.create({
        data: {
          bookId: created.id,
          language: v.language,
          title: `Book ${v.language}`,
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'draft',
          originalLanguage: v.originalLanguage,
          chapters: { create: v.chapters ?? [] },
        },
      });
      ids[v.language] = row.id;
    }
    return { bookId: created.id, ids };
  };

  const TWO_CHAPTERS = [
    { number: 1, title: 'One', content: '<p>Anna arrives in <em>Town</em>.</p>' },
    { number: 2, title: 'Two', content: '<p>Anna leaves.</p><hr /><p>Rain.</p>' },
  ];

  const englishBook = () =>
    book([{ language: 'en', originalLanguage: 'English', chapters: TWO_CHAPTERS }]);

  /** Проходы исполнителя, пока есть что захватить: шаг `continue` ставит задачу снова. */
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      await worker.runOnce();
      const left = await prisma.llmTask.count({
        where: {
          kind: { in: [DOSSIER_TASK_KIND, GLOSSARY_TASK_KIND] },
          status: 'pending',
          runAfter: { lte: new Date() },
          operation: { status: 'active' },
        },
      });
      if (left === 0) return;
    }
    throw new Error('drain did not finish');
  };

  /** Строка ответа `demand*`: у паузы ждущего по лимиту первого поколения её нет. */
  const rowOf = <Row>(demand: { row: Row | null }): Row => {
    expect(demand.row).not.toBeNull();
    return demand.row as Row;
  };

  const waiterOperation = () =>
    prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: new Prisma.Decimal(10) },
    });

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
    tasks = app.get(LlmTaskService);
    dossiers = app.get(DossierService);

    const adminEmail = `f052-admin-${stamp}@test.com`;
    const cmEmail = `f052-cm-${stamp}@test.com`;
    await register(adminEmail);
    await register(cmEmail);
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    tokens.admin = await login(adminEmail);
    tokens.cm = await login(cmEmail);
    // Вошедший без ролей: U6 - 403 на каждой ручке фичи.
    const userEmail = `f052-user-${stamp}@test.com`;
    await register(userEmail);
    tokens.user = await login(userEmail);
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    answer = (name, body) => defaultAnswer(name, body);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
      if (urlOf(url).endsWith('/models')) return Promise.resolve(json(MODELS));
      if (urlOf(url).endsWith('/chat/completions')) {
        const body = JSON.parse((init as RequestInit).body as string) as ChatBody;
        const name = llmCallName(body);
        calls.push({ name, model: body.model, body });
        return Promise.resolve(
          json({
            model: body.model,
            provider: 'E2EProvider',
            choices: [{ message: { content: JSON.stringify(answer(name, body)) } }],
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
    await prisma.llmStageSetting.deleteMany({ where: { stage: { in: ['dossier', 'glossary'] } } });
    await app.close();
  });

  describe('access: admin only', () => {
    const routes = (versionId: string, dossierId: string, opId: string) =>
      [
        ['get', `/admin/versions/${versionId}/translation-source`],
        ['get', `/admin/versions/${versionId}/dossier/estimate`],
        ['get', `/admin/versions/${versionId}/dossier`],
        ['post', `/admin/versions/${versionId}/dossier`],
        ['get', `/admin/dossiers/${dossierId}/glossaries/fr`],
        ['post', `/admin/llm/operations/${opId}/cancel`],
        ['post', `/admin/llm/operations/${opId}/resume`],
      ] as Array<['get' | 'post', string]>;

    it('401 without a token, 403 for a content manager and a user without roles', async () => {
      const { ids } = await englishBook();
      const op = await waiterOperation();
      for (const [method, path] of routes(ids.en as string, op.id, op.id)) {
        await http()[method](path).expect(401);
        await auth(http()[method](path), 'cm').expect(403);
        await auth(http()[method](path), 'user').expect(403);
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('translation source (D8)', () => {
    it('answers by the original language of the book, over HTTP', async () => {
      const { ids } = await book([
        { language: 'ru', originalLanguage: 'русский', chapters: TWO_CHAPTERS },
        { language: 'en', originalLanguage: 'Russian' },
      ]);
      const fromRu = await auth(http().get(`/admin/versions/${ids.ru}/translation-source`)).expect(
        200,
      );
      expect(fromRu.body).toMatchObject({
        canTranslate: true,
        reason: null,
        sourceVersionId: ids.ru,
        sourceLanguage: 'ru',
        originalLanguageRaw: 'русский',
        originalLanguageMismatch: false,
      });
      expect(fromRu.body.targets).toEqual([
        { language: 'en', available: false, reason: 'VERSION_EXISTS' },
        { language: 'es', available: true, reason: null },
        { language: 'fr', available: true, reason: null },
        { language: 'pt', available: true, reason: null },
        { language: 'ru', available: false, reason: 'IS_SOURCE' },
      ]);
      const fromEn = await auth(http().get(`/admin/versions/${ids.en}/translation-source`)).expect(
        200,
      );
      expect(fromEn.body).toMatchObject({
        canTranslate: false,
        reason: 'NOT_ORIGINAL_VERSION',
        sourceVersionId: ids.ru,
      });
    });

    it('an original outside the five languages: the English version is the source, the French one gets NOT_ENGLISH_VERSION, without English - ENGLISH_VERSION_MISSING', async () => {
      const { ids } = await book([
        { language: 'en', originalLanguage: 'Japanese', chapters: TWO_CHAPTERS },
        { language: 'fr', originalLanguage: 'Japanese', chapters: TWO_CHAPTERS },
      ]);
      const fromEn = await auth(http().get(`/admin/versions/${ids.en}/translation-source`)).expect(
        200,
      );
      expect(fromEn.body).toMatchObject({
        canTranslate: true,
        reason: null,
        sourceVersionId: ids.en,
        sourceLanguage: 'en',
        originalLanguageRaw: 'Japanese',
      });
      const fromFr = await auth(http().get(`/admin/versions/${ids.fr}/translation-source`)).expect(
        200,
      );
      expect(fromFr.body).toMatchObject({
        canTranslate: false,
        reason: 'NOT_ENGLISH_VERSION',
        sourceVersionId: ids.en,
      });

      const { ids: noEnglish } = await book([
        { language: 'fr', originalLanguage: 'Japanese', chapters: TWO_CHAPTERS },
      ]);
      const missing = await auth(
        http().get(`/admin/versions/${noEnglish.fr}/translation-source`),
      ).expect(200);
      expect(missing.body).toMatchObject({
        canTranslate: false,
        reason: 'ENGLISH_VERSION_MISSING',
        sourceVersionId: null,
      });
    });

    it('a version of the original without chapter text blocks translation', async () => {
      const { ids } = await book([{ language: 'fr', originalLanguage: 'français' }]);
      const res = await auth(http().get(`/admin/versions/${ids.fr}/translation-source`)).expect(
        200,
      );
      expect(res.body).toMatchObject({ canTranslate: false, reason: 'SOURCE_HAS_NO_CHAPTERS' });
    });

    it('404 for an unknown version', async () => {
      await auth(
        http().get('/admin/versions/00000000-0000-0000-0000-000000000000/translation-source'),
      ).expect(404);
    });
  });

  describe('dossier', () => {
    it('without a key: POST is 503 LLM_DISABLED and nothing is created', async () => {
      process.env.OPENROUTER_API_KEY = '';
      const { ids } = await englishBook();
      const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(503);
      expect(res.body).toMatchObject({ code: 'LLM_DISABLED' });
      const status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body).toMatchObject({ status: 'missing', id: null, sourceVersionId: ids.en });
      expect(calls).toHaveLength(0);
    });

    it('estimate: pieces of the first pass and the limit × 1.5, no model call', async () => {
      const { ids } = await englishBook();
      const res = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(200);
      expect(res.body).toMatchObject({ sourceVersionId: ids.en, chapters: 2, parts: 2 });
      const estimate = new Prisma.Decimal(res.body.estimateUsd as string);
      expect(estimate.gt(0)).toBe(true);
      expect(new Prisma.Decimal(res.body.suggestedLimitUsd as string).eq(estimate.mul(1.5))).toBe(
        true,
      );
      expect(calls).toHaveLength(0);
    });

    it('builds in two passes under its own operation; a fresh one is 409', async () => {
      const { ids } = await englishBook();
      const started = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
      expect(started.body).toMatchObject({ status: 'building', generation: 1, partsDone: 0 });
      expect(started.body.operation).toMatchObject({ kind: 'dossier', status: 'active' });

      await drain();

      expect(callsOf('dossier_part')).toHaveLength(2);
      expect(callsOf('dossier')).toHaveLength(1);
      // Схема ответа - и в `response_format`, и в системном сообщении.
      expect(calls[0].body.messages[0].content).toContain('Answer with JSON only');
      expect(calls[0].body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { name: 'dossier_part', strict: true },
      });
      // Сводка - схема только в тексте: Claude не компилирует её грамматику (Р1 `F05 | F05-R`).
      const [summary] = callsOf('dossier');
      expect(summary.body.response_format).toBeUndefined();
      expect(summary.body.messages[0].content).toContain('Answer with JSON only');
      const ready = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(ready.body).toMatchObject({
        status: 'ready',
        fresh: true,
        formatVersion: 1,
        model: MODEL,
        partsDone: 2,
        data: { characters: DOSSIER.characters, summaryPlan: DOSSIER.summaryPlan },
      });
      expect(ready.body.operation).toMatchObject({ status: 'done' });
      const spent = await prisma.llmCall.aggregate({
        where: { operationId: ready.body.operation.id as string },
        _sum: { costUsd: true },
      });
      expect(
        new Prisma.Decimal(ready.body.operation.spentUsd as string).eq(spent._sum.costUsd ?? 0),
      ).toBe(true);

      const again = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(409);
      expect(again.body).toMatchObject({ code: 'DOSSIER_FRESH' });
      expect(calls).toHaveLength(3);
    });

    it('an edited chapter makes it stale; rebuilding is a new generation and the old glossary stays behind', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const first = await dossiers.latestDossier(ids.en as string);
      await dossiers.demandGlossary(first?.id as string, 'fr');
      await drain();
      const oldGlossary = await prisma.bookGlossary.findFirstOrThrow({
        where: { dossierId: first?.id },
      });
      expect(oldGlossary.status).toBe('ready');

      // Пересохранение того же текста свежести не меняет, правка - меняет.
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 1 } },
        data: { content: TWO_CHAPTERS[0].content },
      });
      let status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body.fresh).toBe(true);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 1 } },
        data: { content: '<p>Anna arrives late.</p>' },
      });
      status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body).toMatchObject({ status: 'ready', fresh: false, generation: 1 });

      const rebuilt = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
      expect(rebuilt.body).toMatchObject({ status: 'building', generation: 2 });
      await drain();
      const second = await dossiers.latestDossier(ids.en as string);
      expect(second).toMatchObject({ generation: 2, status: 'ready' });
      expect(await prisma.bookDossier.findUnique({ where: { id: first?.id } })).toMatchObject({
        status: 'ready',
        generation: 1,
      });

      const glossary = await dossiers.demandGlossary(second?.id as string, 'fr');
      expect(glossary.status).toBe('wait');
      expect(rowOf(glossary).id).not.toBe(oldGlossary.id);
    });

    it('two simultaneous requests: one builder, the second waits for the same dossier, paid once', async () => {
      const { ids } = await englishBook();
      const [a, b] = await Promise.all([
        dossiers.demandDossier(ids.en as string),
        dossiers.demandDossier(ids.en as string),
      ]);
      expect(a.status).toBe('wait');
      expect(b.status).toBe('wait');
      expect(rowOf(a).id).toBe(rowOf(b).id);
      expect(await prisma.bookDossier.count({ where: { sourceVersionId: ids.en } })).toBe(1);
      expect(
        await prisma.llmOperation.count({ where: { kind: 'dossier', bookVersionId: ids.en } }),
      ).toBe(1);

      await drain();
      const [c, d] = await Promise.all([
        dossiers.demandDossier(ids.en as string),
        dossiers.demandDossier(ids.en as string),
      ]);
      expect(c).toMatchObject({ status: 'ready', fresh: true });
      expect(rowOf(d).id).toBe(rowOf(c).id);
      expect(calls).toHaveLength(3);
    });

    it('a crash after the answer of a piece: the retry does not call the model again', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      // Ответ первого куска сохранён, а запись итога шага упала: задача осталась `running`.
      const finish = jest.spyOn(tasks, 'finish').mockRejectedValueOnce(new Error('db down'));
      await worker.runOnce();
      expect(finish).toHaveBeenCalledTimes(1);
      expect(callsOf('dossier_part')).toHaveLength(1);
      const building = await dossiers.latestDossier(ids.en as string);
      expect(await prisma.bookDossierPart.count({ where: { dossierId: building?.id } })).toBe(1);
      finish.mockRestore();

      // Аренда истекла - задачу берёт следующий захват.
      const task = (await prisma.llmTask.findFirst({
        where: { kind: DOSSIER_TASK_KIND, status: 'running', bookVersionId: ids.en },
      })) as LlmTask;
      await prisma.llmTask.update({
        where: { id: task.id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      await drain();

      expect(callsOf('dossier_part')).toHaveLength(2);
      expect(callsOf('dossier')).toHaveLength(1);
      expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({ status: 'ready' });
    });

    it('an answer of the wrong form: one retry with a remark, then the builder fails; one takeover, then the row fails (Р20)', async () => {
      const { ids } = await englishBook();
      answer = (name) => (name === 'dossier_part' ? { summary: 1 } : defaultAnswer(name));
      await dossiers.demandDossier(ids.en as string);
      await drain();

      expect(callsOf('dossier_part')).toHaveLength(2);
      const remark = callsOf('dossier_part')[1].body.messages;
      expect(remark[remark.length - 1].content).toContain('$.summary: expected string');
      let row = await dossiers.latestDossier(ids.en as string);
      expect(row).toMatchObject({ status: 'building', takeovers: 0 });
      const builder = await prisma.llmOperation.findUniqueOrThrow({
        where: { id: row?.operationId as string },
      });
      expect(builder.status).toBe('failed');

      // Ждущий перехватывает строку один раз новой операцией.
      const waiter = await waiterOperation();
      const taken = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(taken.status).toBe('wait');
      row = await dossiers.latestDossier(ids.en as string);
      expect(row).toMatchObject({ status: 'building', takeovers: 1 });
      expect(row?.operationId).not.toBe(builder.id);

      // Упал и перехватчик - строка `failed`, ждущий на паузе `STEP_FAILED`.
      await drain();
      row = await dossiers.latestDossier(ids.en as string);
      expect(row?.status).toBe('failed');
      const after = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id, waitingFor: row?.id },
      });
      expect(after.status).toBe('failed');
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'STEP_FAILED',
      });
      expect(
        await prisma.llmOperation.count({ where: { kind: 'dossier', bookVersionId: ids.en } }),
      ).toBe(2);
    });

    it('a failed builder of a row taken over once is not taken over again: the row fails (Р20)', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      // Перехватчик упал, а строку пометить не успел: операция `failed`, строка ещё `building`.
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'failed' },
      });
      await prisma.bookDossier.update({ where: { id: rowOf(started).id }, data: { takeovers: 1 } });

      const waiter = await waiterOperation();
      const demand = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(demand.status).toBe('failed');
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        status: 'failed',
        takeovers: 1,
      });
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'STEP_FAILED',
      });
      expect(
        await prisma.llmOperation.count({ where: { kind: 'dossier', bookVersionId: ids.en } }),
      ).toBe(1);
    });

    it('the builder hits its limit: the waiter pauses DOSSIER_PAUSED without new operations; resume finishes it', async () => {
      const { ids } = await englishBook();
      await auth(http().post(`/admin/versions/${ids.en}/dossier`))
        .send({ limitUsd: '0.00000001' })
        .expect(202);
      await drain();
      const row = (await dossiers.latestDossier(ids.en as string)) as {
        operationId: string;
        id: string;
      };
      expect(
        await prisma.llmOperation.findUnique({ where: { id: row.operationId } }),
      ).toMatchObject({
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      });
      expect(calls).toHaveLength(0);

      const waiter = await waiterOperation();
      const before = await prisma.llmOperation.count();
      const demand = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(demand).toMatchObject({ status: 'paused', builderOperationId: row.operationId });
      expect(await prisma.llmOperation.count()).toBe(before);
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'DOSSIER_PAUSED',
      });

      // Редактор поднимает лимит и продолжает досье - одной ручкой.
      await auth(http().post(`/admin/llm/operations/${row.operationId}/resume`))
        .send({ limitUsd: 'abc' })
        .expect(400);
      // Без ключа задачу некому исполнить: 503, операция остаётся на паузе.
      process.env.OPENROUTER_API_KEY = '';
      const noKey = await auth(http().post(`/admin/llm/operations/${row.operationId}/resume`))
        .send({ limitUsd: '10' })
        .expect(503);
      expect(noKey.body).toMatchObject({ code: 'LLM_DISABLED' });
      expect(
        await prisma.llmOperation.findUnique({ where: { id: row.operationId } }),
      ).toMatchObject({ status: 'paused' });
      process.env.OPENROUTER_API_KEY = FAKE_KEY;
      const resumed = await auth(http().post(`/admin/llm/operations/${row.operationId}/resume`))
        .send({ limitUsd: '10' })
        .expect(200);
      expect(resumed.body).toMatchObject({
        status: 'active',
        pauseReason: null,
        limitUsd: '10.00000000',
      });
      await drain();
      expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({ status: 'ready' });
    });

    it('cancelling the builder fails the row, the waiter gets STEP_FAILED; cancel twice is 409', async () => {
      const { ids } = await englishBook();
      const waiter = await waiterOperation();
      const first = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      const opId = rowOf(first).operationId as string;
      const cancelled = await auth(http().post(`/admin/llm/operations/${opId}/cancel`)).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled' });
      expect(await prisma.bookDossier.findUnique({ where: { id: rowOf(first).id } })).toMatchObject(
        {
          status: 'failed',
        },
      );
      expect(await prisma.llmTask.count({ where: { operationId: opId, status: 'pending' } })).toBe(
        0,
      );

      const after = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id, waitingFor: rowOf(first).id },
      });
      expect(after.status).toBe('failed');
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        pauseReason: 'STEP_FAILED',
      });

      const twice = await auth(http().post(`/admin/llm/operations/${opId}/cancel`)).expect(409);
      expect(twice.body).toMatchObject({ code: 'LLM_OPERATION_NOT_CANCELLABLE' });
      // Следующий, кому досье нужно, строит его новым поколением.
      const next = await dossiers.demandDossier(ids.en as string);
      expect(next).toMatchObject({ status: 'wait' });
      expect(rowOf(next).generation).toBe(2);
      expect(calls).toHaveLength(0);
    });

    it('resume of a finished operation is 409 even with a limit below its spend', async () => {
      const op = await waiterOperation();
      await prisma.llmOperation.update({
        where: { id: op.id },
        data: { status: 'cancelled', spentUsd: new Prisma.Decimal('1') },
      });
      const res = await auth(http().post(`/admin/llm/operations/${op.id}/resume`))
        .send({ limitUsd: '0' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'LLM_OPERATION_NOT_RESUMABLE' });
    });

    it('resume: 409 for an operation that is not paused or has no resumable kind, 404 for an unknown one', async () => {
      const active = await waiterOperation();
      const notPaused = await auth(http().post(`/admin/llm/operations/${active.id}/resume`)).expect(
        409,
      );
      expect(notPaused.body).toMatchObject({ code: 'LLM_OPERATION_NOT_RESUMABLE' });
      await tasks.pauseOperation(active.id, 'LIMIT_REACHED');
      const noKind = await auth(http().post(`/admin/llm/operations/${active.id}/resume`)).expect(
        409,
      );
      expect(noKind.body).toMatchObject({ code: 'LLM_OPERATION_NOT_RESUMABLE' });
      await auth(
        http().post('/admin/llm/operations/00000000-0000-0000-0000-000000000000/resume'),
      ).expect(404);
    });

    it('the text changes mid-build: the row fails at once, the next press builds a new generation', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await worker.runOnce(); // первый кусок сохранён
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 2 } },
        data: { content: '<p>Anna stays.</p>' },
      });
      await drain();
      const first = await dossiers.latestDossier(ids.en as string);
      expect(first).toMatchObject({ status: 'failed', generation: 1, takeovers: 0 });
      expect(callsOf('dossier_part')).toHaveLength(1);

      const again = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
      expect(again.body).toMatchObject({ status: 'building', generation: 2 });
      await drain();
      expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({
        status: 'ready',
        generation: 2,
      });
    });

    it('a failed builder already taken over: the button builds a new generation instead of 202 failed', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'failed' },
      });
      await prisma.bookDossier.update({ where: { id: rowOf(started).id }, data: { takeovers: 1 } });
      const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
      expect(res.body).toMatchObject({ status: 'building', generation: 2 });
    });

    it('a done builder with a row still building is a failure, not an endless wait', async () => {
      const { ids } = await englishBook();
      const waiter = await waiterOperation();
      const started = await dossiers.demandDossier(ids.en as string);
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'done' },
      });
      const demand = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(demand.status).toBe('failed');
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        status: 'failed',
      });
    });

    it('the row is ready but the process died before closing the operation: the next step closes it', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const row = await dossiers.latestDossier(ids.en as string);
      const opId = row?.operationId as string;
      await prisma.llmOperation.update({ where: { id: opId }, data: { status: 'active' } });
      await tasks.enqueue({
        kind: DOSSIER_TASK_KIND,
        operationId: opId,
        payload: { dossierId: row?.id as string },
      });
      await drain();
      expect(await prisma.llmOperation.findUnique({ where: { id: opId } })).toMatchObject({
        status: 'done',
      });
      expect(calls).toHaveLength(3);
    });

    it('resume while the paused step is still running adds no second task', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      const opId = rowOf(started).operationId as string;
      const claimed = await tasks.claim([DOSSIER_TASK_KIND], 'owner-in-flight');
      expect(claimed?.operationId).toBe(opId);
      await tasks.pauseOperation(opId, 'LIMIT_REACHED');
      await auth(http().post(`/admin/llm/operations/${opId}/resume`)).expect(200);
      const live = await prisma.llmTask.count({
        where: { operationId: opId, status: { in: ['pending', 'running'] } },
      });
      expect(live).toBe(1);
    });

    it('the resume write itself refuses a limit below spent + reserved (not only the pre-check)', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      const opId = rowOf(started).operationId as string;
      await tasks.pauseOperation(opId, 'LIMIT_REACHED');
      // Резерв вырос между проверкой и записью: условие записи держит его само.
      await prisma.llmOperation.update({
        where: { id: opId },
        data: { reservedUsd: new Prisma.Decimal('0.5') },
      });
      await expect(
        tasks.resumeOperation(
          opId,
          [
            {
              kind: DOSSIER_TASK_KIND,
              operationId: opId,
              payload: { dossierId: rowOf(started).id },
            },
          ],
          new Prisma.Decimal('0.4'),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await prisma.llmOperation.findUnique({ where: { id: opId } })).toMatchObject({
        status: 'paused',
      });
    });

    it('the builder finishes between the reads: the waiter gets the ready dossier, not STEP_FAILED', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      const stale = rowOf(started);
      // Строитель достроил строку и закрыл операцию, а ждущий прочитал её ещё `building`.
      await prisma.bookDossier.update({ where: { id: stale.id }, data: { status: 'ready' } });
      await prisma.llmOperation.update({
        where: { id: stale.operationId as string },
        data: { status: 'done' },
      });
      jest.spyOn(dossiers, 'latestDossier').mockResolvedValueOnce(stale);
      const waiter = await waiterOperation();
      const demand = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(demand.status).toBe('ready');
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'active',
        pauseReason: null,
      });
      expect(await prisma.bookDossier.findUnique({ where: { id: stale.id } })).toMatchObject({
        status: 'ready',
      });
    });

    it('closing the row and pausing the waiter are one write: a failed pause leaves the row as it was', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'cancelled' },
      });
      const waiter = await waiterOperation();
      jest.spyOn(tasks, 'pauseOperation').mockRejectedValueOnce(new Error('db down'));
      await expect(
        dossiers.demandDossier(ids.en as string, { waiter: { operationId: waiter.id } }),
      ).rejects.toThrow('db down');
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        status: 'building',
      });
      // Повтор шага ждущего закрывает строку и ставит паузу вместе - нового поколения нет.
      const again = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(again.status).toBe('failed');
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'STEP_FAILED',
      });
      expect(await prisma.bookDossier.count({ where: { sourceVersionId: ids.en } })).toBe(1);
    });

    it('cancel works on a paused operation and closes its row; an unknown operation is 404', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      const opId = rowOf(started).operationId as string;
      await tasks.pauseOperation(opId, 'LIMIT_REACHED');
      await auth(http().post(`/admin/llm/operations/${opId}/cancel`)).expect(200);
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        status: 'failed',
      });
      await auth(
        http().post('/admin/llm/operations/00000000-0000-0000-0000-000000000000/cancel'),
      ).expect(404);
    });

    it('without a key the button answers 503 LLM_DISABLED even when the ceiling is spent', async () => {
      process.env.OPENROUTER_API_KEY = '';
      const { ids } = await englishBook();
      await prisma.llmBudget.update({
        where: { id: LLM_BUDGET_ID },
        data: { ceilingUsd: new Prisma.Decimal(1), spentUsd: new Prisma.Decimal(1) },
      });
      const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(503);
      expect(res.body).toMatchObject({ code: 'LLM_DISABLED' });
    });

    it('resume refuses a limit below what is already spent and reserved', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      const opId = rowOf(started).operationId as string;
      await prisma.llmOperation.update({
        where: { id: opId },
        data: { spentUsd: new Prisma.Decimal('0.5') },
      });
      await tasks.pauseOperation(opId, 'LIMIT_REACHED');
      await auth(http().post(`/admin/llm/operations/${opId}/resume`))
        .send({ limitUsd: '0.4' })
        .expect(400);
      expect(await prisma.llmOperation.findUnique({ where: { id: opId } })).toMatchObject({
        status: 'paused',
      });
    });

    it('the ceiling is spent: the button is 409 LLM_CEILING_REACHED and creates nothing (В11)', async () => {
      const { ids } = await englishBook();
      await prisma.llmBudget.update({
        where: { id: LLM_BUDGET_ID },
        data: { ceilingUsd: new Prisma.Decimal(1), spentUsd: new Prisma.Decimal(1) },
      });
      const before = await prisma.llmOperation.count();
      const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(409);
      expect(res.body).toMatchObject({ code: 'LLM_CEILING_REACHED' });
      expect(await prisma.llmOperation.count()).toBe(before);
      expect(await prisma.bookDossier.count({ where: { sourceVersionId: ids.en } })).toBe(0);
    });

    it('a takeover that does not fit the waiter limit pauses the waiter LIMIT_REACHED without a new operation', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'failed' },
      });
      const waiter = await prisma.llmOperation.create({
        data: { kind: 'translation_run', limitUsd: new Prisma.Decimal('0.00000001') },
      });
      const before = await prisma.llmOperation.count();
      const demand = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(demand).toMatchObject({ status: 'paused', reason: 'LIMIT_REACHED' });
      expect(await prisma.llmOperation.count()).toBe(before);
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      });
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        status: 'building',
        takeovers: 0,
      });
    });

    it('a summary that misses a chapter gets a remark, then a full answer is accepted', async () => {
      const { ids } = await englishBook();
      let summaries = 0;
      answer = (name, body) => {
        if (name !== 'dossier') return defaultAnswer(name, body);
        summaries += 1;
        const full = dossierFor(body);
        return summaries === 1 ? { ...full, chapters: full.chapters.slice(0, 1) } : full;
      };
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const remark = callsOf('dossier')[1].body.messages;
      expect(remark[remark.length - 1].content).toContain('$.chapters: missing reader chapters 2');
      expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({ status: 'ready' });
    });

    it('validates input: bad limit 400, unknown version 404, no chapters 409', async () => {
      const { ids } = await englishBook();
      await auth(http().post(`/admin/versions/${ids.en}/dossier`))
        .send({ limitUsd: '-1' })
        .expect(400);
      await auth(http().post(`/admin/versions/${ids.en}/dossier`))
        .send({ limitUsd: 'abc' })
        .expect(400);
      const unknown = '00000000-0000-0000-0000-000000000000';
      await auth(http().get(`/admin/versions/${unknown}/dossier`)).expect(404);
      await auth(http().get(`/admin/versions/${unknown}/dossier/estimate`)).expect(404);
      await auth(http().post(`/admin/versions/${unknown}/dossier`)).expect(404);
      const { ids: empty } = await book([{ language: 'en', originalLanguage: 'English' }]);
      const noText = await auth(http().get(`/admin/versions/${empty.en}/dossier/estimate`)).expect(
        409,
      );
      expect(noText.body).toMatchObject({ code: 'SOURCE_HAS_NO_CHAPTERS' });
      await auth(http().post(`/admin/versions/${empty.en}/dossier`)).expect(409);
      expect(calls).toHaveLength(0);
    });

    it('a version takes the dossier of its D8 source over HTTP (Р5), its own when the source has no text (В10)', async () => {
      const { ids } = await book([
        { language: 'ru', originalLanguage: 'русский', chapters: TWO_CHAPTERS },
        { language: 'en', originalLanguage: 'Russian', chapters: TWO_CHAPTERS },
      ]);
      const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
      expect(res.body.sourceVersionId).toBe(ids.ru);
      const { ids: noText } = await book([
        { language: 'ru', originalLanguage: 'русский' },
        { language: 'en', originalLanguage: 'Russian', chapters: TWO_CHAPTERS },
      ]);
      const own = await auth(http().get(`/admin/versions/${noText.en}/dossier`)).expect(200);
      expect(own.body).toMatchObject({ status: 'missing', sourceVersionId: noText.en });
    });

    it('builds the dossier and a glossary of a seed book (acceptance of the batch)', async () => {
      const seed = await prisma.bookVersion.findFirstOrThrow({
        where: { book: { slug: 'summary-acceptance-full' }, language: 'en' },
        select: { id: true, _count: { select: { chapters: true } } },
      });
      expect(seed._count.chapters).toBeGreaterThan(1);
      const started = await auth(http().post(`/admin/versions/${seed.id}/dossier`)).expect(202);
      await drain();
      const ready = await auth(http().get(`/admin/versions/${seed.id}/dossier`)).expect(200);
      expect(ready.body).toMatchObject({ status: 'ready', fresh: true });
      expect((ready.body.data.chapters as unknown[]).length).toBe(seed._count.chapters);
      expect(callsOf('dossier_part').length).toBe(seed._count.chapters);
      await dossiers.demandGlossary(started.body.id as string, 'fr');
      await drain();
      const glossary = await auth(
        http().get(`/admin/dossiers/${started.body.id}/glossaries/fr`),
      ).expect(200);
      expect(glossary.body).toMatchObject({ status: 'ready', data: GLOSSARY });
      expect((glossary.body.data.entries as unknown[]).length).toBeGreaterThan(0);
    });

    it('a stage model without a price: estimate and build are 409 LLM_NO_PRICE, not 500', async () => {
      const { ids } = await englishBook();
      // Строка настройки мимо ручки: модель вне каталога, потолка цены нет.
      await prisma.llmStageSetting.create({
        data: { stage: 'dossier', model: 'x/not-in-catalog', fallbacks: [], enabled: true },
      });
      try {
        const estimate = await auth(
          http().get(`/admin/versions/${ids.en}/dossier/estimate`),
        ).expect(409);
        expect(estimate.body).toMatchObject({ code: 'LLM_NO_PRICE' });
        const build = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(409);
        expect(build.body).toMatchObject({ code: 'LLM_NO_PRICE' });
        // И с лимитом редактора: цена проверяется до операции, а не отказом резерва потом.
        const withLimit = await auth(http().post(`/admin/versions/${ids.en}/dossier`))
          .send({ limitUsd: '5' })
          .expect(409);
        expect(withLimit.body).toMatchObject({ code: 'LLM_NO_PRICE' });
        expect(await prisma.bookDossier.count({ where: { sourceVersionId: ids.en } })).toBe(0);
      } finally {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      }
    });

    it('the estimate covers every piece answer and the summary read back from them', async () => {
      const { ids } = await englishBook();
      const res = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(200);
      // Нижняя граница без формулы реализации: два куска и сводка платят выход по maxTokens,
      // а вход сводки - не меньше ответов двух кусков по символам.
      const maxTokens = 16_000;
      const outPrice = new Prisma.Decimal('0.000002');
      const inPrice = new Prisma.Decimal('0.000001');
      const floor = outPrice.mul(maxTokens * 3).add(inPrice.mul(2 * maxTokens));
      expect(new Prisma.Decimal(res.body.estimateUsd as string).gte(floor)).toBe(true);
    });

    it('the button taking over a failed builder uses the editor limit and refuses at the ceiling', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'failed' },
      });
      await prisma.llmBudget.update({
        where: { id: LLM_BUDGET_ID },
        data: { ceilingUsd: new Prisma.Decimal(1), spentUsd: new Prisma.Decimal(1) },
      });
      const refused = await auth(http().post(`/admin/versions/${ids.en}/dossier`))
        .send({ limitUsd: '5' })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'LLM_CEILING_REACHED' });
      await resetBudget();
      const taken = await auth(http().post(`/admin/versions/${ids.en}/dossier`))
        .send({ limitUsd: '5' })
        .expect(202);
      expect(taken.body.operation).toMatchObject({ limitUsd: '5.00000000' });
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        takeovers: 1,
        previousOperationId: rowOf(started).operationId,
      });
      const status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body.previousOperation).toMatchObject({
        id: rowOf(started).operationId,
        status: 'failed',
      });
    });

    it('two waiters racing for one failed builder: one takeover, one new operation', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      await prisma.llmOperation.update({
        where: { id: rowOf(started).operationId as string },
        data: { status: 'failed' },
      });
      const [w1, w2] = await Promise.all([waiterOperation(), waiterOperation()]);
      const results = await Promise.all([
        dossiers.demandDossier(ids.en as string, { waiter: { operationId: w1.id } }),
        dossiers.demandDossier(ids.en as string, { waiter: { operationId: w2.id } }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['wait', 'wait']);
      expect(
        await prisma.llmOperation.count({ where: { kind: 'dossier', bookVersionId: ids.en } }),
      ).toBe(2);
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        takeovers: 1,
      });
    });

    it('the source version is deleted mid-build: the step closes the operation', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      const opId = rowOf(started).operationId as string;
      const task = await prisma.llmTask.findFirstOrThrow({ where: { operationId: opId } });
      // Каскад версии снимает строку досье; задачу держит другая операция (свою снял бы каскад).
      await prisma.bookDossier.delete({ where: { id: rowOf(started).id } });
      expect(await prisma.llmTask.findUnique({ where: { id: task.id } })).toMatchObject({
        status: 'pending',
      });
      await drain();
      expect(await prisma.llmOperation.findUnique({ where: { id: opId } })).toMatchObject({
        status: 'failed',
      });
      expect(calls).toHaveLength(0);
    });

    it('a summary that does not fit the model context fails before the call; the waiter does not rebuild it, the button does', async () => {
      const { ids } = await englishBook();
      try {
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: TINY })
          .expect(200);
        await dossiers.demandDossier(ids.en as string);
        await drain();
        expect(callsOf('dossier_part')).toHaveLength(2);
        expect(callsOf('dossier')).toHaveLength(0);
        const row = await dossiers.latestDossier(ids.en as string);
        expect(row).toMatchObject({
          status: 'failed',
          failedReason: 'DOSSIER_TOO_LONG',
          takeovers: 0,
          model: TINY,
        });
        const status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
        expect(status.body).toMatchObject({ status: 'failed', failedReason: 'DOSSIER_TOO_LONG' });

        const waiter = await waiterOperation();
        const demand = await dossiers.demandDossier(ids.en as string, {
          waiter: { operationId: waiter.id },
        });
        expect(demand.status).toBe('failed');
        expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
          pauseReason: 'STEP_FAILED',
        });
        expect(await prisma.bookDossier.count({ where: { sourceVersionId: ids.en } })).toBe(1);

        const button = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
        expect(button.body).toMatchObject({ status: 'building', generation: 2 });
      } finally {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      }
    });

    it('a title or number edit also makes the dossier stale', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 1 } },
        data: { title: 'Uno' },
      });
      let status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body.fresh).toBe(false);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 1 } },
        data: { title: 'One' },
      });
      status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body.fresh).toBe(true);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 2 } },
        data: { number: 3 },
      });
      status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
      expect(status.body.fresh).toBe(false);
    });

    it('without a key the button is 503 even over a fresh dossier', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      process.env.OPENROUTER_API_KEY = '';
      const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(503);
      expect(res.body).toMatchObject({ code: 'LLM_DISABLED' });
    });

    it('a waiter whose row failed on old text gets a new generation on the new text', async () => {
      const { ids } = await englishBook();
      const waiter = await waiterOperation();
      const first = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      await worker.runOnce();
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 2 } },
        data: { content: '<p>Anna stays.</p>' },
      });
      await drain();
      expect(await prisma.bookDossier.findUnique({ where: { id: rowOf(first).id } })).toMatchObject(
        {
          status: 'failed',
          failedReason: 'DOSSIER_SOURCE_CHANGED',
        },
      );
      const again = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id, waitingFor: rowOf(first).id },
      });
      expect(again).toMatchObject({ status: 'wait' });
      expect(rowOf(again).generation).toBe(2);
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'active',
      });
    });

    it('a disabled dossier stage refuses the button with 409 before any operation', async () => {
      const { ids } = await englishBook();
      try {
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: MODEL, enabled: false })
          .expect(200);
        const before = await prisma.llmOperation.count();
        const res = await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(409);
        expect(res.body).toMatchObject({ code: 'LLM_STAGE_DISABLED' });
        expect(await prisma.llmOperation.count()).toBe(before);
      } finally {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      }
    });

    it('the summary estimate is capped by the model context', async () => {
      const { ids } = await englishBook();
      const big = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(200);
      try {
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: TINY })
          .expect(200);
        const tiny = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(
          200,
        );
        // Цены моделей одинаковые: разница - только вход сводки, ограниченный контекстом.
        expect(
          new Prisma.Decimal(tiny.body.estimateUsd as string).lt(
            new Prisma.Decimal(big.body.estimateUsd as string),
          ),
        ).toBe(true);
        // Контекст больше суммы ответов кусков - потолок не срабатывает, оценка та же.
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: HUGE })
          .expect(200);
        const huge = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(
          200,
        );
        expect(huge.body.estimateUsd).toBe(big.body.estimateUsd);
      } finally {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      }
    });

    it('marking the row ready and closing the operation are one write', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      const complete = jest
        .spyOn(tasks, 'completeOperation')
        .mockRejectedValueOnce(new Error('db down'));
      await drain().catch(() => undefined);
      expect(complete).toHaveBeenCalled();
      const row = await dossiers.latestDossier(ids.en as string);
      // Закрытие упало - строка не стала `ready` под операцией, которой не закрыли.
      // Строка осталась `building` под упавшим строителем: её достроит перехват (Р20).
      expect(row?.status).toBe('building');
    });

    it('a glossary ready row and closing its operation are one write', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const dossier = await dossiers.latestDossier(ids.en as string);
      const started = await dossiers.demandGlossary(dossier?.id as string, 'fr');
      const complete = jest
        .spyOn(tasks, 'completeOperation')
        .mockRejectedValueOnce(new Error('db down'));
      await drain().catch(() => undefined);
      expect(complete).toHaveBeenCalled();
      expect(
        await prisma.bookGlossary.findUniqueOrThrow({ where: { id: rowOf(started).id } }),
      ).toMatchObject({ status: 'building' });
    });

    it('a failing completion callback rolls the operation back to active', async () => {
      const op = await waiterOperation();
      await expect(
        tasks.completeOperation(op.id, () => Promise.reject(new Error('db down'))),
      ).rejects.toThrow('db down');
      expect(await prisma.llmOperation.findUnique({ where: { id: op.id } })).toMatchObject({
        status: 'active',
      });
    });

    it('a waiter over a building row whose builder failed before an edit builds anew', async () => {
      const { ids } = await englishBook();
      const first = await dossiers.demandDossier(ids.en as string);
      await tasks.failOperation(rowOf(first).operationId as string);
      await prisma.chapter.update({
        where: { bookVersionId_number: { bookVersionId: ids.en as string, number: 2 } },
        data: { content: '<p>Anna stays.</p>' },
      });
      const waiter = await waiterOperation();
      const again = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(again).toMatchObject({ status: 'wait' });
      expect(rowOf(again).generation).toBe(2);
      expect(await prisma.bookDossier.findUnique({ where: { id: rowOf(first).id } })).toMatchObject(
        {
          status: 'failed',
          failedReason: 'DOSSIER_SOURCE_CHANGED',
        },
      );
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'active',
      });
    });

    it('a waiter without room for a new generation pauses LIMIT_REACHED, no operation', async () => {
      const { ids } = await englishBook();
      const waiter = await prisma.llmOperation.create({
        data: { kind: 'translation_run', limitUsd: new Prisma.Decimal(0) },
      });
      const before = await prisma.llmOperation.count({ where: { kind: 'dossier' } });
      const demand = await dossiers.demandDossier(ids.en as string, {
        waiter: { operationId: waiter.id },
      });
      expect(demand).toMatchObject({ status: 'paused', reason: 'LIMIT_REACHED', row: null });
      expect(await prisma.llmOperation.count({ where: { kind: 'dossier' } })).toBe(before);
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      });
    });

    it('a waiter without room for a glossary pauses LIMIT_REACHED, no operation', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const dossier = await dossiers.latestDossier(ids.en as string);
      const waiter = await prisma.llmOperation.create({
        data: { kind: 'translation_run', limitUsd: new Prisma.Decimal(0) },
      });
      const before = await prisma.llmOperation.count({ where: { kind: 'dossier' } });
      const demand = await dossiers.demandGlossary(dossier?.id as string, 'fr', {
        waiter: { operationId: waiter.id },
      });
      expect(demand).toMatchObject({ status: 'paused', reason: 'LIMIT_REACHED', row: null });
      expect(await prisma.llmOperation.count({ where: { kind: 'dossier' } })).toBe(before);
      expect(await prisma.llmOperation.findUnique({ where: { id: waiter.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      });
    });

    it('a disabled dossier stage refuses the estimate with 409', async () => {
      const { ids } = await englishBook();
      try {
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: MODEL, enabled: false })
          .expect(200);
        const res = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(
          409,
        );
        expect(res.body).toMatchObject({ code: 'LLM_STAGE_DISABLED' });
      } finally {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      }
    });

    const numberedChapters = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        number: i + 1,
        title: `C${i + 1}`,
        content: '<p>Rain.</p>',
      }));

    it('a source over 2000 chapters is estimated and built, not refused (F05-Rb)', async () => {
      const { ids } = await book([
        { language: 'en', originalLanguage: 'English', chapters: numberedChapters(2001) },
      ]);
      const res = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(200);
      expect(res.body).toMatchObject({ chapters: 2001, parts: 2001 });
      await auth(http().post(`/admin/versions/${ids.en}/dossier`)).expect(202);
      const row = await dossiers.latestDossier(ids.en as string);
      expect((row?.plan as unknown[]).length).toBe(2001);
    });

    describe('summary by groups (F05-Rb)', () => {
      /** 250 кусков - 250 шагов исполнителя на базе: дольше общего срока теста. */
      const GROUPS_TIMEOUT_MS = 300_000;

      /**
       * Проходы до конца построения: кусков больше, чем проходов у `drain`. Шаг `continue` ставится
       * на «сейчас» по часам процесса, захват сверяет часы базы - срок сдвигается назад.
       */
      const drainAll = async () => {
        for (let i = 0; i < 1000; i++) {
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
          const left = await prisma.llmTask.count({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending', operation: { status: 'active' } },
          });
          if (left === 0) return;
        }
        throw new Error('drainAll did not finish');
      };

      /**
       * `maxTokens` 2 000: по 12 глав в группе уровня 0 (`F05-12`), и выше уровня 0 в контекст
       * SMALL влезает несколько ответов групп.
       */
      const setSmall = () =>
        auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: SMALL, maxTokens: 2_000 })
          .expect(200);

      afterEach(async () => {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      });

      it(
        'a book that does not fit the context is summed by groups, then by the groups',
        async () => {
          const { ids } = await book([
            { language: 'en', originalLanguage: 'English', chapters: numberedChapters(250) },
          ]);
          // Огромный контекст при том же `maxTokens`: группы - только по пределу глав (`F05-12`).
          await auth(http().put('/admin/llm/stage-settings/dossier'))
            .send({ model: HUGE, maxTokens: 2_000 })
            .expect(200);
          const plain = await auth(http().get(`/admin/versions/${ids.en}/dossier/estimate`)).expect(
            200,
          );
          await setSmall();
          const grouped = await auth(
            http().get(`/admin/versions/${ids.en}/dossier/estimate`),
          ).expect(200);
          // Те же куски, но в маленький контекст влезает меньше ответов: групп больше, оценка выше.
          expect(
            new Prisma.Decimal(grouped.body.estimateUsd as string).gt(
              new Prisma.Decimal(plain.body.estimateUsd as string),
            ),
          ).toBe(true);

          await dossiers.demandDossier(ids.en as string);
          await drainAll();
          const row = await dossiers.latestDossier(ids.en as string);
          expect(row).toMatchObject({ status: 'ready' });
          const groups = await prisma.bookDossierGroup.findMany({
            where: { dossierId: row?.id },
            orderBy: [{ level: 'asc' }, { groupIndex: 'asc' }],
          });
          const level0 = groups.filter((g) => g.level === 0);
          expect(level0.length).toBeGreaterThan(1);
          expect(groups.every((g) => g.done)).toBe(true);
          // Группы подряд, без дыр и наложений.
          expect(level0.reduce((sum, g) => sum + g.itemCount, 0)).toBe(250);
          expect(level0.map((g) => g.firstItem)).toEqual(
            level0.map((_, i) => level0.slice(0, i).reduce((sum, g) => sum + g.itemCount, 0)),
          );
          // Вызовы: куски, по вызову на группу и одна итоговая сводка.
          expect(callsOf('dossier_part')).toHaveLength(250);
          expect(callsOf('dossier')).toHaveLength(groups.length + 1);
          const data = row?.data as { chapters: Array<{ number: number }> };
          expect(data.chapters.map((c) => c.number)).toHaveLength(250);
          // Бюджет закрыт без подвисшего резерва.
          expect(
            await prisma.llmOperation.findUnique({ where: { id: row?.operationId as string } }),
          ).toMatchObject({ status: 'done' });
        },
        GROUPS_TIMEOUT_MS,
      );

      it(
        'a book over the chapter limit of one answer: groups list their chapters, the code assembles the dossier (F05-12)',
        async () => {
          // Контекст неизвестен - вход влез бы одной сводкой, но 250 глав одним ответом не
          // перечислить в 16 000 токенов: группы по 40 глав, итог без списков.
          const { ids } = await book([
            { language: 'en', originalLanguage: 'English', chapters: numberedChapters(250) },
          ]);
          await dossiers.demandDossier(ids.en as string);
          await drainAll();
          const row = await dossiers.latestDossier(ids.en as string);
          expect(row).toMatchObject({ status: 'ready' });
          const groups = await groupsOf(ids.en as string);
          expect(groups.map((g) => [g.level, g.firstChapter, g.lastChapter])).toEqual([
            [0, 1, 40],
            [0, 41, 80],
            [0, 81, 120],
            [0, 121, 160],
            [0, 161, 200],
            [0, 201, 240],
            [0, 241, 250],
          ]);
          // Куски, по вызову на группу, один итог - и больше ничего.
          expect(callsOf('dossier_part')).toHaveLength(250);
          const summaries = callsOf('dossier');
          expect(summaries).toHaveLength(8);
          // Группы пишут списки своих глав, итог - нет: у него их и не просят.
          const [last] = summaries.slice(-1);
          expect(last.body.messages[0].content).toContain(
            'chapters and summaryPlan are assembled separately',
          );
          expect(last.body.messages[0].content).not.toContain('every reader chapter');
          for (const group of summaries.slice(0, 7)) {
            expect(group.body.messages[0].content).toContain('every reader chapter');
            // Своя доля потолка разделов: 40 глав из 250 при семи группах - 31 раздел, хвост в 10 - 7.
            expect(group.body.messages[0].content).toMatch(/At most (31|7) sections/);
            expect(group.body.messages[0].content).toContain('At most 64 characters');
          }
          expect(last.body.messages[0].content).toContain('At most 64 characters');
          const data = row?.data as {
            chapters: Array<{ number: number }>;
            summaryPlan: Array<{ number: number }>;
          };
          expect(data.chapters.map((c) => c.number)).toEqual(
            Array.from({ length: 250 }, (_, i) => i + 1),
          );
          // Разделы семи групп подряд, номера заново.
          expect(data.summaryPlan.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
          // Ход групп виден в статусе (`F05-12`, Р6 `F05-Rb`).
          const status = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
          expect(status.body).toMatchObject({
            status: 'ready',
            partsDone: 250,
            groupsDone: 7,
            groupsTotal: 7,
          });
        },
        GROUPS_TIMEOUT_MS,
      );

      it(
        'exactly the chapter limit: one summary without groups; one chapter more: groups (F05-12)',
        async () => {
          const at = await book([
            { language: 'en', originalLanguage: 'English', chapters: numberedChapters(40) },
          ]);
          await dossiers.demandDossier(at.ids.en as string);
          await drainAll();
          expect(await groupsOf(at.ids.en as string)).toEqual([]);
          expect(callsOf('dossier')).toHaveLength(1);
          const status = await auth(http().get(`/admin/versions/${at.ids.en}/dossier`)).expect(200);
          expect(status.body).toMatchObject({ status: 'ready', groupsDone: 0, groupsTotal: 0 });

          calls.length = 0;
          const over = await book([
            { language: 'en', originalLanguage: 'English', chapters: numberedChapters(41) },
          ]);
          await dossiers.demandDossier(over.ids.en as string);
          await drainAll();
          expect(
            (await groupsOf(over.ids.en as string)).map((g) => [g.firstChapter, g.lastChapter]),
          ).toEqual([
            [1, 40],
            [41, 41],
          ]);
          expect(callsOf('dossier')).toHaveLength(3);
          expect(await dossiers.latestDossier(over.ids.en as string)).toMatchObject({
            status: 'ready',
          });
        },
        GROUPS_TIMEOUT_MS,
      );

      it(
        'a crash after the answer of a group: the retry does not pay for the group again',
        async () => {
          const { ids } = await book([
            { language: 'en', originalLanguage: 'English', chapters: numberedChapters(250) },
          ]);
          await setSmall();
          await dossiers.demandDossier(ids.en as string);
          // Первый проход и заведение групп.
          for (let i = 0; i < 300; i++) {
            await worker.runOnce();
            const row = await dossiers.latestDossier(ids.en as string);
            if (
              row &&
              (await prisma.bookDossierGroup.count({ where: { dossierId: row.id } })) > 0
            ) {
              break;
            }
          }
          const row = (await dossiers.latestDossier(ids.en as string)) as { id: string };
          expect(callsOf('dossier')).toHaveLength(0);

          // Шаг ставится на «сейчас» по часам процесса, захват сверяет часы базы: без сдвига
          // следующий проход может его не увидеть.
          await prisma.llmTask.updateMany({
            where: { bookVersionId: ids.en, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          // Ответ первой группы сохранён, а запись итога шага упала.
          const finish = jest.spyOn(tasks, 'finish').mockRejectedValueOnce(new Error('db down'));
          await worker.runOnce();
          finish.mockRestore();
          expect(callsOf('dossier')).toHaveLength(1);
          expect(
            await prisma.bookDossierGroup.count({ where: { dossierId: row.id, done: true } }),
          ).toBe(1);
          const task = (await prisma.llmTask.findFirst({
            where: { kind: DOSSIER_TASK_KIND, status: 'running', bookVersionId: ids.en },
          })) as LlmTask;
          await prisma.llmTask.update({
            where: { id: task.id },
            data: { leaseUntil: new Date(Date.now() - 1000) },
          });
          await drainAll();

          expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({ status: 'ready' });
          // Первая группа не позвана заново: на каждую группу один вызов и одна итоговая сводка.
          const groups = await prisma.bookDossierGroup.count({ where: { dossierId: row.id } });
          expect(callsOf('dossier')).toHaveLength(groups + 1);
          expect(callsOf('dossier_part')).toHaveLength(250);
        },
        GROUPS_TIMEOUT_MS,
      );

      /** Ответ куска с текстом-заполнителем: размер входа сводки задаёт тест, а не заглушка. */
      const paddedPart = (chars: number) => ({ ...PART, summary: 'x'.repeat(chars) });
      /**
       * Ответ сводки (группы или итога) с заполнителем в заметках о повествовании: списки глав
       * и разделов наверх не уходят (`F05-12`), заполнитель в них не дошёл бы до уровня выше.
       */
      const paddedDossier = (body: ChatBody | undefined, chars: number) => {
        const dossier = dossierFor(body);
        return { ...dossier, narration: { ...dossier.narration, notes: 'y'.repeat(chars) } };
      };
      const setGroupModel = () =>
        auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: GROUP, maxTokens: 2_000 })
          .expect(200);
      const groupsOf = async (versionId: string) => {
        const row = await dossiers.latestDossier(versionId);
        return prisma.bookDossierGroup.findMany({
          where: { dossierId: row?.id },
          orderBy: [{ level: 'asc' }, { groupIndex: 'asc' }],
        });
      };
      const eightChapters = () =>
        book([{ language: 'en', originalLanguage: 'English', chapters: numberedChapters(8) }]);

      it('results of groups that do not fit together are grouped again: a level above zero, then the summary', async () => {
        // Вход ~24 тыс. символов: ответы кусков по ~6 тыс. - по два в группу; ответы групп по
        // ~7 тыс. (без списков глав, вход уровня выше - без их правил) - три не влезают, по два
        // влезают: уровень 1 из двух групп, итог из двух.
        answer = (name, body) =>
          name === 'dossier_part'
            ? paddedPart(5_600)
            : name === 'dossier'
              ? paddedDossier(body, 6_000)
              : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        await drainAll();
        expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({ status: 'ready' });
        const groups = await groupsOf(ids.en as string);
        expect(groups.map((g) => [g.level, g.firstItem, g.itemCount])).toEqual([
          [0, 0, 2],
          [0, 2, 2],
          [0, 4, 2],
          [0, 6, 2],
          [1, 0, 2],
          [1, 2, 2],
        ]);
        expect(
          groups.filter((g) => g.level === 1).map((g) => [g.firstChapter, g.lastChapter]),
        ).toEqual([
          [1, 4],
          [5, 8],
        ]);
        expect(groups.every((g) => g.done)).toBe(true);
        expect(callsOf('dossier')).toHaveLength(groups.length + 1);
        // Выше уровня 0 результаты групп уходят без списков глав и разделов (`F05-12`).
        const above = callsOf('dossier').filter((c) =>
          c.body.messages[0].content.includes('assembled separately'),
        );
        expect(above).toHaveLength(3);
        for (const call of above) {
          expect(call.body.messages[1].content).not.toContain('"summaryPlan"');
        }
      });

      it('a level above zero that does not halve fails DOSSIER_TOO_LONG without paying for that level (Р3)', async () => {
        // Ответы групп по ~9 тыс.: ни одна пара не влезает - уровень 1 из четырёх групп по одной
        // ничего не сужает, отказ без вызова.
        answer = (name, body) =>
          name === 'dossier_part'
            ? paddedPart(5_600)
            : name === 'dossier'
              ? paddedDossier(body, 8_000)
              : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        await drainAll();
        expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({
          status: 'failed',
          failedReason: 'DOSSIER_TOO_LONG',
        });
        const groups = await groupsOf(ids.en as string);
        expect(groups.map((g) => g.level)).toEqual([0, 0, 0, 0]);
        expect(callsOf('dossier')).toHaveLength(4);
      });

      it('level 0 of single groups whose next level could not narrow fails DOSSIER_TOO_LONG before paying for a group (F05-12)', async () => {
        // Вход ~24 тыс. символов, ответы кусков по ~12 тыс.: в группе уровня 0 по одному куску.
        // При `maxTokens` 16 000 выше уровня 0 заведомо не влезают два ответа группы - уровень 1
        // не сузился бы, и отказ пришёл бы после оплаты восьми групп. Отказ - до первой из них.
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(12_000) : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: NARROW })
          .expect(200);
        await dossiers.demandDossier(ids.en as string);
        await drainAll();
        expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({
          status: 'failed',
          failedReason: 'DOSSIER_TOO_LONG',
          model: NARROW,
        });
        expect(await groupsOf(ids.en as string)).toEqual([]);
        expect(callsOf('dossier_part')).toHaveLength(8);
        expect(callsOf('dossier')).toHaveLength(0);
      });

      /** Проходы, пока все заведённые группы уровня 0 не ответят; итог ещё не позван. */
      const answerLevel0 = async (versionId: string) => {
        for (let i = 0; i < 60; i++) {
          const groups = await groupsOf(versionId);
          if (groups.length > 0 && groups.every((g) => g.done)) return;
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
        }
        throw new Error('level 0 did not finish');
      };

      it('a hole between the chapter lists of level 0 groups fails the row before the final call is paid (F05-12)', async () => {
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(5_600) : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        // Ход групп виден в статусе посреди построения.
        for (let i = 0; i < 60; i++) {
          const groups = await groupsOf(ids.en as string);
          if (groups.some((g) => g.done)) break;
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
        }
        const mid = await auth(http().get(`/admin/versions/${ids.en}/dossier`)).expect(200);
        expect(mid.body).toMatchObject({ status: 'building', groupsDone: 1, groupsTotal: 4 });

        await answerLevel0(ids.en as string);
        const [, second] = await groupsOf(ids.en as string);
        const data = second.data as { chapters: Array<{ number: number }> };
        // Глава 3 пропала из списка своей группы.
        await prisma.bookDossierGroup.update({
          where: { id: second.id },
          data: { data: { ...data, chapters: data.chapters.filter((c) => c.number !== 3) } },
        });
        const paid = callsOf('dossier').length;
        await drainAll();
        expect(callsOf('dossier')).toHaveLength(paid);
        // Строка ждёт одного перехвата (Р20), операция закрыта отказом по ответу модели.
        const row = await dossiers.latestDossier(ids.en as string);
        expect(row).toMatchObject({ status: 'building', takeovers: 0, failedReason: null });
        expect(
          await prisma.llmOperation.findUnique({ where: { id: row?.operationId as string } }),
        ).toMatchObject({ status: 'failed' });
        expect(
          await prisma.llmTask.findFirst({
            where: { operationId: row?.operationId as string, kind: DOSSIER_TASK_KIND },
            orderBy: { createdAt: 'desc' },
          }),
        ).toMatchObject({ lastError: 'DOSSIER_INVALID_RESPONSE' });
      });

      it('maxTokens lowered after level 0 was set so that a group lists too many chapters: DOSSIER_TOO_LONG without a call (F05-12)', async () => {
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(5_600) : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        for (let i = 0; i < 50 && (await groupsOf(ids.en as string)).length === 0; i++) {
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
        }
        expect((await groupsOf(ids.en as string)).map((g) => g.itemCount)).toEqual([2, 2, 2, 2]);
        // 400 токенов - по одной главе в группе: заведённые по две не перепаковываются (Р4).
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: GROUP, maxTokens: 400 })
          .expect(200);
        await drainAll();
        expect(callsOf('dossier')).toHaveLength(0);
        expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({
          status: 'failed',
          failedReason: 'DOSSIER_TOO_LONG',
        });
      });

      it('a group is sized with the titles of every chapter, as the summary is', async () => {
        // Две пустые главы по краям с длинными названиями: со своими названиями четыре куска влезли
        // бы одной группой, а итог со всеми названиями - нет. Группы меряются как итог - по два.
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(3_200) : defaultAnswer(name, body);
        const long = 'T'.repeat(4_000);
        const chapters = [
          { number: 1, title: long, content: '' },
          ...[2, 3, 4, 5].map((n) => ({ number: n, title: `C${n}`, content: '<p>Rain.</p>' })),
          { number: 6, title: long, content: '' },
        ];
        const { ids } = await book([{ language: 'en', originalLanguage: 'English', chapters }]);
        // `maxTokens` 1 000: вход ~26 тыс. символов, и выше уровня 0 при всех названиях глав
        // заведомо влезают два ответа группы (`F05-12`) - иначе отказ до оплаты групп.
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: GROUP, maxTokens: 1_000 })
          .expect(200);
        await dossiers.demandDossier(ids.en as string);
        await drainAll();
        expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({ status: 'ready' });
        const groups = await groupsOf(ids.en as string);
        expect(groups.map((g) => [g.level, g.itemCount])).toEqual([
          [0, 2],
          [0, 2],
        ]);
        expect(callsOf('dossier')).toHaveLength(3);
      });

      it('the stage model changed to a smaller context after the groups were set: DOSSIER_TOO_LONG without a call (Р4)', async () => {
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(5_600) : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        for (let i = 0; i < 50 && (await groupsOf(ids.en as string)).length === 0; i++) {
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
        }
        expect((await groupsOf(ids.en as string)).length).toBeGreaterThan(1);
        expect(callsOf('dossier')).toHaveLength(0);
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: TINY })
          .expect(200);
        await drainAll();
        expect(callsOf('dossier')).toHaveLength(0);
        expect(await dossiers.latestDossier(ids.en as string)).toMatchObject({
          status: 'failed',
          failedReason: 'DOSSIER_TOO_LONG',
          model: TINY,
        });
        // Ждущий при той же модели строку не перестраивает (`tooLongAgain`).
        const waiter = await waiterOperation();
        const demand = await dossiers.demandDossier(ids.en as string, {
          waiter: { operationId: waiter.id },
        });
        expect(demand.status).toBe('failed');
      });

      it('the lease is lost while the level was being packed: no group rows are written (Р5)', async () => {
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(5_600) : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        const row = (await dossiers.latestDossier(ids.en as string)) as { id: string };
        // Первый проход целиком: восемь кусков сохранены, уровень ещё не заведён.
        for (
          let i = 0;
          i < 50 && (await prisma.bookDossierPart.count({ where: { dossierId: row.id } })) < 8;
          i++
        ) {
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
        }
        expect(await prisma.bookDossierPart.count({ where: { dossierId: row.id } })).toBe(8);
        expect(await prisma.bookDossierGroup.count({ where: { dossierId: row.id } })).toBe(0);
        await prisma.llmTask.updateMany({
          where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
          data: { runAfter: new Date(Date.now() - 1000) },
        });
        // Пока шли пробы упаковки, аренду отдали другому: строки уровня этот шаг не пишет.
        const renew = jest
          .spyOn(tasks, 'renewLease')
          .mockImplementation((taskId: string) =>
            Promise.reject(new LlmTaskLeaseLostError(taskId)),
          );
        await worker.runOnce();
        expect(renew).toHaveBeenCalled();
        renew.mockRestore();
        expect(await prisma.bookDossierGroup.count({ where: { dossierId: row.id } })).toBe(0);
        expect(callsOf('dossier')).toHaveLength(0);
      });

      it('the row is taken over while the level was being packed: the old step writes no group rows (Р7)', async () => {
        answer = (name, body) =>
          name === 'dossier_part' ? paddedPart(5_600) : defaultAnswer(name, body);
        const { ids } = await eightChapters();
        await setGroupModel();
        await dossiers.demandDossier(ids.en as string);
        const row = (await dossiers.latestDossier(ids.en as string)) as { id: string };
        for (
          let i = 0;
          i < 50 && (await prisma.bookDossierPart.count({ where: { dossierId: row.id } })) < 8;
          i++
        ) {
          await prisma.llmTask.updateMany({
            where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
            data: { runAfter: new Date(Date.now() - 1000) },
          });
          await worker.runOnce();
        }
        expect(await prisma.bookDossierPart.count({ where: { dossierId: row.id } })).toBe(8);
        await prisma.llmTask.updateMany({
          where: { kind: DOSSIER_TASK_KIND, status: 'pending' },
          data: { runAfter: new Date(Date.now() - 1000) },
        });
        // Аренда задачи жива, но строку, пока шла упаковка, перехватила другая операция.
        const taker = await waiterOperation();
        const renew = jest.spyOn(tasks, 'renewLease').mockImplementation(async () => {
          await prisma.bookDossier.update({
            where: { id: row.id },
            data: { operationId: taker.id },
          });
        });
        await worker.runOnce();
        expect(renew).toHaveBeenCalled();
        renew.mockRestore();
        expect(await prisma.bookDossierGroup.count({ where: { dossierId: row.id } })).toBe(0);
        expect(callsOf('dossier')).toHaveLength(0);
      });

      it('a group that does not fit even alone fails the row with DOSSIER_TOO_LONG', async () => {
        const { ids } = await englishBook();
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: TINY })
          .expect(200);
        await dossiers.demandDossier(ids.en as string);
        await drain();
        expect(callsOf('dossier')).toHaveLength(0);
        const row = await dossiers.latestDossier(ids.en as string);
        expect(row).toMatchObject({ status: 'failed', failedReason: 'DOSSIER_TOO_LONG' });
        expect(await prisma.bookDossierGroup.count({ where: { dossierId: row?.id } })).toBe(0);
      });
    });

    it('a planned part whose chapter is gone closes the row with DOSSIER_SOURCE_CHANGED', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      jest.spyOn(prisma.chapter, 'findUnique').mockResolvedValueOnce(null);
      await drain();
      expect(
        await prisma.bookDossier.findUnique({ where: { id: rowOf(started).id } }),
      ).toMatchObject({
        status: 'failed',
        failedReason: 'DOSSIER_SOURCE_CHANGED',
      });
      expect(
        await prisma.llmOperation.findUnique({
          where: { id: rowOf(started).operationId as string },
        }),
      ).toMatchObject({ status: 'failed' });
    });

    it('failOperation and completeOperation move only an active operation', async () => {
      const op = await waiterOperation();
      await tasks.pauseOperation(op.id, 'LIMIT_REACHED');
      expect(await tasks.failOperation(op.id)).toBe(false);
      expect(await tasks.completeOperation(op.id)).toBe(false);
      expect(await prisma.llmOperation.findUnique({ where: { id: op.id } })).toMatchObject({
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      });
      const done = await waiterOperation();
      expect(await tasks.completeOperation(done.id)).toBe(true);
      expect(await prisma.llmOperation.findUnique({ where: { id: done.id } })).toMatchObject({
        status: 'done',
      });
      const active = await waiterOperation();
      await tasks.enqueue({ kind: DOSSIER_TASK_KIND, operationId: active.id, payload: {} });
      expect(await tasks.failOperation(active.id)).toBe(true);
      expect(await prisma.llmOperation.findUnique({ where: { id: active.id } })).toMatchObject({
        status: 'failed',
        pauseReason: null,
      });
      expect(await prisma.llmTask.findFirst({ where: { operationId: active.id } })).toMatchObject({
        status: 'cancelled',
      });
    });
  });

  describe('glossary', () => {
    it('is built once per (dossier, language) and read over HTTP', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const dossier = await dossiers.latestDossier(ids.en as string);
      await auth(http().get(`/admin/dossiers/${dossier?.id}/glossaries/fr`)).expect(404);

      const [a, b] = await Promise.all([
        dossiers.demandGlossary(dossier?.id as string, 'fr'),
        dossiers.demandGlossary(dossier?.id as string, 'fr'),
      ]);
      expect(rowOf(a).id).toBe(rowOf(b).id);
      await drain();
      expect(await dossiers.demandGlossary(dossier?.id as string, 'fr')).toMatchObject({
        status: 'ready',
      });
      expect(callsOf('glossary')).toHaveLength(1);
      const op = await prisma.llmOperation.findUniqueOrThrow({
        where: { id: rowOf(a).operationId as string },
      });
      expect(op).toMatchObject({ kind: 'dossier', status: 'done' });

      const res = await auth(http().get(`/admin/dossiers/${dossier?.id}/glossaries/fr`)).expect(
        200,
      );
      expect(res.body).toMatchObject({
        language: 'fr',
        status: 'ready',
        data: GLOSSARY,
        history: [],
      });
    });

    it('a glossary of the wrong form fails, is taken over once, cancelled - failed, then rebuilt', async () => {
      const { ids } = await englishBook();
      await dossiers.demandDossier(ids.en as string);
      await drain();
      const dossier = await dossiers.latestDossier(ids.en as string);
      answer = (name, body) => (name === 'glossary' ? { entries: 1 } : defaultAnswer(name, body));
      const first = await dossiers.demandGlossary(dossier?.id as string, 'fr');
      await drain();
      expect(callsOf('glossary')).toHaveLength(2);
      let row = await prisma.bookGlossary.findUniqueOrThrow({ where: { id: rowOf(first).id } });
      expect(row).toMatchObject({ status: 'building', takeovers: 0 });

      const waiter = await waiterOperation();
      const taken = await dossiers.demandGlossary(dossier?.id as string, 'fr', {
        waiter: { operationId: waiter.id },
      });
      expect(taken.status).toBe('wait');
      row = await prisma.bookGlossary.findUniqueOrThrow({ where: { id: rowOf(first).id } });
      expect(row.takeovers).toBe(1);

      // Перехватчик стоит на паузе - «продолжить» ставит шаг глоссария.
      await tasks.pauseOperation(row.operationId as string, 'LIMIT_REACHED');
      answer = (name, body) => defaultAnswer(name, body);
      await auth(http().post(`/admin/llm/operations/${row.operationId}/resume`)).expect(200);
      await auth(http().post(`/admin/llm/operations/${row.operationId}/cancel`)).expect(200);
      row = await prisma.bookGlossary.findUniqueOrThrow({ where: { id: rowOf(first).id } });
      expect(row.status).toBe('failed');

      // `failed -> building` новой операцией, перехват снова разрешён.
      const rebuilt = await dossiers.demandGlossary(dossier?.id as string, 'fr');
      expect(rebuilt.status).toBe('wait');
      row = await prisma.bookGlossary.findUniqueOrThrow({ where: { id: rowOf(first).id } });
      expect(row).toMatchObject({ status: 'building', takeovers: 0 });
      await drain();
      expect(
        await prisma.bookGlossary.findUnique({ where: { id: rowOf(first).id } }),
      ).toMatchObject({
        status: 'ready',
      });
    });

    it('an unknown language is 404, as everywhere behind LangParamPipe', async () => {
      await auth(
        http().get('/admin/dossiers/00000000-0000-0000-0000-000000000000/glossaries/xx'),
      ).expect(404);
    });

    it('needs a ready dossier', async () => {
      const { ids } = await englishBook();
      const started = await dossiers.demandDossier(ids.en as string);
      await expect(dossiers.demandGlossary(rowOf(started).id, 'fr')).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe('stage settings (D5)', () => {
    it('the dossier stage is registered and the next call goes to the model changed on the screen', async () => {
      const list = await auth(http().get('/admin/llm/stage-settings')).expect(200);
      expect((list.body.items as Array<{ stage: string }>).map((s) => s.stage)).toEqual(
        expect.arrayContaining(['dossier', 'glossary']),
      );
      const { ids } = await englishBook();
      try {
        await auth(http().put('/admin/llm/stage-settings/dossier'))
          .send({ model: ALT })
          .expect(200);
        await dossiers.demandDossier(ids.en as string);
        await drain();
        expect(new Set(calls.map((c) => c.model))).toEqual(new Set([ALT]));
      } finally {
        await prisma.llmStageSetting.deleteMany({ where: { stage: 'dossier' } });
      }
    });
  });
});
