/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { llmTaskConflict } from '../src/modules/llm-worker/llm-worker.errors';
import { DossierService } from '../src/modules/translation/dossier/dossier.service';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-3: сравнение моделей на главе. Исполнитель настоящий, его проходы зовутся руками (таймер
 * в e2e не заведён, Р25); `fetch` подменён всегда, ответ модели выбирается по имени схемы
 * ответа. Досье и глоссарий строятся своими операциями раньше перевода (С2).
 */
describe('Translation compare (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const MODEL = 'anthropic/claude-sonnet-5.5';
  const ALT = 'z/alt-model';
  const THIRD = 'z/third-model';
  /** Модель с крошечным контекстом: кусок с досье в неё не влезает. */
  const TINY = 'z/tiny-context';
  const MODELS = {
    data: [MODEL, ALT, THIRD, TINY, 'google/gemma-4-31b-it:free'].map((id) => ({
      id,
      name: id,
      ...(id === TINY ? { context_length: 1_000 } : {}),
      pricing: id.endsWith(':free')
        ? { prompt: '0', completion: '0' }
        : { prompt: '0.000001', completion: '0.000002' },
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
    chapters: [{ number: 1, title: 'One', summary: 'Arrival.' }],
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
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();
  const slugs: string[] = [];
  const calls: Array<{ name: string; model: string; body: ChatBody }> = [];
  let answer: (name: string, body: ChatBody) => unknown;
  /** Стоимость вызова в ответе провайдера, $ - для пробы лимита. */
  let costOf: (name: string, model: string) => number;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  /** Блоки куска из запроса: `[n] текст` построчно после заголовка. */
  const blocksOf = (body: ChatBody) => {
    const user = body.messages[1]?.content ?? '';
    const list = user.split('Blocks to translate, as "[n] text":\n')[1] ?? '';
    return list
      .split('\n')
      .map((line) => /^\[(\d+)\] (.*)$/s.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ n: Number(m[1]), text: `ES ${m[2]}` }));
  };

  const defaultAnswer = (name: string, body: ChatBody): unknown => {
    if (name === 'dossier_part') return PART;
    if (name === 'dossier') return DOSSIER;
    if (name === 'glossary') return GLOSSARY;
    if (name === 'split') {
      const first = /^\[(\d+)\]/m.exec(body.messages[1]?.content ?? '');
      return { boundaryBlock: Number(first?.[1] ?? 0) };
    }
    // ALT всегда теряет блоки: два повтора с замечанием, затем отказ колонки.
    if (body.model === ALT) return { blocks: [], glossaryFindings: [] };
    return {
      blocks: blocksOf(body),
      glossaryFindings: [{ source: 'Town', target: 'Pueblo', kind: 'place', note: '' }],
    };
  };

  const callsOf = (name: string, model?: string) =>
    calls.filter((c) => c.name === name && (model === undefined || c.model === model));

  const http = () => request(httpServerOf(app));
  const auth = (r: request.Test, who: 'admin' | 'cm' | 'user' = 'admin') =>
    r.set('Authorization', `Bearer ${tokens[who]}`);

  const register = async (email: string) => {
    await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
  };
  const login = async (email: string) =>
    (
      (await http().post('/auth/login').send({ email, password: 'password123' }).expect(200))
        .body as { accessToken: string }
    ).accessToken;

  const book = async (
    versions: Array<{
      language: Language;
      originalLanguage: string;
      chapters?: Array<{ number: number; title: string; content: string }>;
    }>,
    intakeLanguages?: Language[],
  ) => {
    const slug = `f053-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const { book: created } = await createBookWithRights(
      prisma,
      slug,
      intakeLanguages ? { languages: intakeLanguages } : {},
    );
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

  const SHORT = [
    { number: 1, title: 'One', content: '<p>Anna arrives.</p><p>— Hello, Annie.</p>' },
  ];
  const englishBook = (chapters = SHORT) =>
    book([{ language: 'en', originalLanguage: 'English', chapters }]);

  /** Проходы исполнителя до конца; ожидание `wait` сдвигается в «сейчас», чтобы не ждать таймер. */
  const drain = async () => {
    for (let i = 0; i < 80; i++) {
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

  const start = (versionId: string, body: Record<string, unknown>) =>
    auth(http().post(`/admin/versions/${versionId}/translation-compare`)).send({
      chapterNumber: 1,
      targetLanguage: 'es',
      models: [MODEL, ALT],
      ...body,
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
    const adminEmail = `f053-admin-${stamp}@test.com`;
    const cmEmail = `f053-cm-${stamp}@test.com`;
    await register(adminEmail);
    await register(cmEmail);
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    tokens.admin = await login(adminEmail);
    tokens.cm = await login(cmEmail);
    // Вошедший без ролей: U6 - 403 на каждой ручке фичи.
    const userEmail = `f053-user-${stamp}@test.com`;
    await register(userEmail);
    tokens.user = await login(userEmail);
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    answer = defaultAnswer;
    costOf = () => 0.0001;
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
            usage: { prompt_tokens: 100, completion_tokens: 50, cost: costOf(name, body.model) },
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

  it('401 without a token, 403 for a content manager and a user without roles on every route', async () => {
    const { ids } = await englishBook();
    const v = ids.en as string;
    const routes: Array<['get' | 'post', string]> = [
      [
        'get',
        `/admin/versions/${v}/translation-compare/estimate?chapterNumber=1&targetLanguage=es&models=${MODEL},${ALT}`,
      ],
      ['post', `/admin/versions/${v}/translation-compare`],
      ['get', `/admin/versions/${v}/translation-compares`],
      ['get', `/admin/translation-compares/00000000-0000-0000-0000-000000000000`],
    ];
    for (const [method, path] of routes) {
      await http()[method](path).expect(401);
      await auth(http()[method](path), 'cm').expect(403);
      await auth(http()[method](path), 'user').expect(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('without a key POST is 503 LLM_DISABLED and nothing is created', async () => {
    process.env.OPENROUTER_API_KEY = '';
    const { ids } = await englishBook();
    const res = await start(ids.en as string, {}).expect(503);
    expect(res.body).toMatchObject({ code: 'LLM_DISABLED' });
    expect(await prisma.translationCompare.count({ where: { bookVersionId: ids.en } })).toBe(0);
  });

  it('refusals before the start: not a source, the source language, unknown and repeated models, 1 model', async () => {
    const { ids } = await book([
      { language: 'en', originalLanguage: 'English', chapters: SHORT },
      { language: 'fr', originalLanguage: 'English', chapters: SHORT },
    ]);
    const notSource = await start(ids.fr as string, {}).expect(409);
    expect(notSource.body).toMatchObject({ code: 'NOT_ORIGINAL_VERSION', sourceVersionId: ids.en });
    const isSource = await start(ids.en as string, { targetLanguage: 'en' }).expect(400);
    expect(isSource.body).toMatchObject({ code: 'COMPARE_TARGET_IS_SOURCE' });
    const unknown = await start(ids.en as string, { models: [MODEL, 'x/nope'] }).expect(400);
    expect(unknown.body).toMatchObject({ code: 'LLM_MODEL_UNKNOWN' });
    await start(ids.en as string, { models: [MODEL, MODEL] }).expect(400);
    await start(ids.en as string, { models: [MODEL] }).expect(400);
    await start(ids.en as string, { chapterNumber: 9 }).expect(404);
    // Язык, на котором версия уже есть, разрешён: сравнение версию не создаёт (С5).
    await auth(
      http().get(
        `/admin/versions/${ids.en}/translation-compare/estimate?chapterNumber=1&targetLanguage=fr&models=${MODEL}&models=${ALT}`,
      ),
    ).expect(200);
    expect(calls).toHaveLength(0);
  });

  it('the ceiling reached: 409 without an operation (С4)', async () => {
    const { ids } = await englishBook();
    await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { spentUsd: 100 } });
    const res = await start(ids.en as string, {}).expect(409);
    expect(res.body).toMatchObject({ code: 'LLM_CEILING_REACHED' });
    expect(
      await prisma.llmOperation.count({ where: { kind: 'compare', bookVersionId: ids.en } }),
    ).toBe(0);
  });

  it('estimate before the dossier: dossier and glossary lines, the glossary as an upper bound, no call', async () => {
    const { ids } = await englishBook();
    const res = await auth(
      http().get(
        `/admin/versions/${ids.en}/translation-compare/estimate?chapterNumber=1&targetLanguage=es&models=${MODEL},${ALT}`,
      ),
    ).expect(200);
    expect(res.body).toMatchObject({ chunks: 1, upperBound: true });
    expect(res.body.dossier).toMatchObject({ upperBound: false });
    expect(res.body.glossary).toMatchObject({ upperBound: true });
    expect(res.body.models.map((m: { model: string }) => m.model)).toEqual([MODEL, ALT]);
    // Лимит вмещает досье: иначе сравнение встало бы LIMIT_REACHED до первого перевода (С12).
    expect(
      new Prisma.Decimal(res.body.suggestedLimitUsd as string).gte(
        new Prisma.Decimal(res.body.dossier.suggestedLimitUsd as string),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('builds the dossier and glossary first; one model fails, the other is visible; no version, glossary untouched', async () => {
    const { bookId, ids } = await englishBook();
    const versionsBefore = await prisma.bookVersion.count({ where: { bookId } });
    const started = await start(ids.en as string, {}).expect(202);
    expect(started.body).toMatchObject({
      chapterNumber: 1,
      language: 'es',
      waitingForContext: true,
      operation: { kind: 'compare', status: 'active' },
    });
    expect(started.body.results.map((r: { status: string }) => r.status)).toEqual([
      'queued',
      'queued',
    ]);
    await drain();

    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.operation).toMatchObject({ status: 'done' });
    expect(res.body.originalHtml).toBe(SHORT[0].content);
    const [main, alt] = res.body.results as Array<Record<string, unknown>>;
    expect(main).toMatchObject({ model: MODEL, status: 'done', error: null, chunksDone: 1 });
    expect(main.html).toBe('<p>ES Anna arrives.</p><p>ES — Hello, Annie.</p>');
    expect(alt).toMatchObject({
      model: ALT,
      status: 'failed',
      error: 'COMPARE_INVALID_RESPONSE',
      html: null,
    });
    // ALT: попытка и два повтора с замечанием (С11).
    expect(callsOf('translation', ALT)).toHaveLength(3);
    expect(callsOf('translation', MODEL)).toHaveLength(1);
    // Перевод видит досье первым и запись глоссария главного персонажа.
    const sent = callsOf('translation', MODEL)[0].body;
    expect(sent.messages[0].content).toContain('Book dossier:');
    expect(sent.messages[1].content).toContain('"target":"Ana"');

    // Стоимость колонки - сумма её вызовов.
    for (const r of [main, alt]) {
      const sum = await prisma.llmCall.aggregate({
        where: {
          operationId: res.body.operation.id as string,
          stage: 'translate',
          requestedModel: r.model as string,
        },
        _sum: { costUsd: true },
      });
      expect(new Prisma.Decimal(r.costUsd as string).eq(sum._sum.costUsd ?? 0)).toBe(true);
    }
    expect(await prisma.bookVersion.count({ where: { bookId } })).toBe(versionsBefore);
    const glossary = await prisma.bookGlossary.findFirstOrThrow({
      where: { dossier: { sourceVersionId: ids.en }, language: 'es' },
    });
    // Находки перевода в глоссарий не пишутся.
    expect(glossary.data).toEqual(GLOSSARY);
    expect(glossary.history).toEqual([]);

    const list = await auth(http().get(`/admin/versions/${ids.en}/translation-compares`)).expect(
      200,
    );
    expect(list.body.pagination).toMatchObject({ total: 1 });
    expect(list.body.items[0]).toMatchObject({
      id: started.body.id as string,
      models: [MODEL, ALT],
    });
  });

  it('the limit pauses the compare before overspending; resume continues without paying the done model again', async () => {
    const { ids } = await englishBook();
    // Досье и глоссарий уже есть: лимит сравнения тратят только переводы.
    const first = await start(ids.en as string, {}).expect(202);
    await drain();
    const glossaryBefore = await prisma.bookGlossary.findFirstOrThrow({
      where: { dossier: { sourceVersionId: ids.en }, language: 'es' },
    });
    calls.length = 0;
    costOf = (name) => (name === 'translation' ? 0.02 : 0.0001);

    const second = await start(ids.en as string, {
      models: [MODEL, THIRD],
      limitUsd: '0.04',
    }).expect(202);
    expect(second.body.waitingForContext).toBe(true);
    await drain();
    const paused = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: second.body.operation.id as string },
    });
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'LIMIT_REACHED' });
    expect(paused.spentUsd.add(paused.reservedUsd).lte(paused.limitUsd)).toBe(true);
    expect(callsOf('translation', MODEL)).toHaveLength(1);
    expect(callsOf('translation', THIRD)).toHaveLength(0);
    // Досье и глоссарий не перестраивались.
    expect(callsOf('dossier')).toHaveLength(0);
    expect(callsOf('glossary')).toHaveLength(0);

    await auth(http().post(`/admin/llm/operations/${second.body.operation.id}/resume`))
      .send({ limitUsd: '1' })
      .expect(200);
    await drain();
    const res = await auth(http().get(`/admin/translation-compares/${second.body.id}`)).expect(200);
    expect(res.body.operation).toMatchObject({ status: 'done' });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['done', 'done']);
    expect(callsOf('translation', MODEL)).toHaveLength(1);
    expect(callsOf('translation', THIRD)).toHaveLength(1);
    const glossaryAfter = await prisma.bookGlossary.findUniqueOrThrow({
      where: { id: glossaryBefore.id },
    });
    expect(glossaryAfter.data).toEqual(glossaryBefore.data);
    expect(glossaryAfter.updatedAt).toEqual(glossaryBefore.updatedAt);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it('a long chapter is cut into pieces; each piece gets the tail of the previous one; a split refusal falls back to code', async () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const content = Array.from({ length: 40 }, (_, i) => `<p>Anna ${i} ${words(99)}</p>`).join('');
    const { ids } = await englishBook([{ number: 1, title: 'One', content }]);
    // Модель `split` отвечает не по форме: граница ставится кодом.
    answer = (name, body) => (name === 'split' ? { wrong: true } : defaultAnswer(name, body));
    const started = await start(ids.en as string, { models: [MODEL, THIRD] }).expect(202);
    await drain();
    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.chunks).toBeGreaterThan(1);
    expect(callsOf('split').length).toBeGreaterThan(0);
    const pieces = callsOf('translation', MODEL);
    expect(pieces).toHaveLength(res.body.chunks as number);
    expect(pieces[0].body.messages[1].content).not.toContain(
      'End of the previous translated piece',
    );
    expect(pieces[1].body.messages[1].content).toContain(
      'End of the previous translated piece: ES Anna',
    );
    for (const r of res.body.results as Array<{ status: string; html: string }>) {
      expect(r.status).toBe('done');
      expect((r.html.match(/<p>ES Anna/g) ?? []).length).toBe(40);
    }
  });

  it('the chapter edited mid-compare fails the operation instead of mixing texts', async () => {
    const { ids } = await englishBook();
    const started = await start(ids.en as string, {}).expect(202);
    await prisma.chapter.updateMany({
      where: { bookVersionId: ids.en, number: 1 },
      data: { content: '<p>Changed.</p>' },
    });
    await drain();
    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.operation).toMatchObject({ status: 'failed' });
    expect(res.body.results.map((r: { error: string }) => r.error)).toEqual([
      'COMPARE_CHAPTER_CHANGED',
      'COMPARE_CHAPTER_CHANGED',
    ]);
    expect(callsOf('translation')).toHaveLength(0);
  });

  it('each contested joint asks split once: the plan is replayed from saved picks, not paid again', async () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    const content = Array.from({ length: 60 }, (_, i) => `<p>Anna ${i} ${words(99)}</p>`).join('');
    const { ids } = await englishBook([{ number: 1, title: 'One', content }]);
    const started = await start(ids.en as string, { models: [MODEL, THIRD] }).expect(202);
    await drain();
    const row = await prisma.translationCompare.findUniqueOrThrow({
      where: { id: started.body.id as string },
    });
    const picks = Object.keys(row.splitPicks as Record<string, number>);
    expect(picks.length).toBeGreaterThan(1);
    // Нарезка проходит главу заново на каждом шаге: без сохранённых выборов стыки
    // спрашивались бы снова, и вызовов было бы больше, чем стыков.
    expect(callsOf('split')).toHaveLength(picks.length);
    expect(row.sourceLanguage).toBe('en');
  });

  it('a chapter without translatable text is refused before the start', async () => {
    const { ids } = await englishBook([{ number: 1, title: 'One', content: '<hr><hr>' }]);
    const res = await start(ids.en as string, {}).expect(409);
    expect(res.body).toMatchObject({ code: 'COMPARE_CHAPTER_EMPTY' });
    expect(
      await prisma.llmOperation.count({ where: { kind: 'compare', bookVersionId: ids.en } }),
    ).toBe(0);
  });

  it('keeps only n and text of the answer; a block emptied by the markup white list gets a remark', async () => {
    const { ids } = await englishBook();
    let translations = 0;
    answer = (name, body) => {
      if (name !== 'translation' || body.model !== MODEL) return defaultAnswer(name, body);
      translations += 1;
      const blocks = blocksOf(body).map((b) => ({ ...b, comment: 'Here is the translation' }));
      // Первый ответ: блок, который белый список сведёт к пустому; второй - по делу.
      if (translations === 1) blocks[0] = { ...blocks[0], text: '<script>x</script>' };
      return { blocks, glossaryFindings: [], note: 'Translated by me' };
    };
    const started = await start(ids.en as string, {}).expect(202);
    await drain();
    const remark = callsOf('translation', MODEL)[1].body.messages.at(-1)?.content ?? '';
    expect(remark).toContain('empty after removing markup');
    const column = await prisma.translationCompareModel.findFirstOrThrow({
      where: { compareId: started.body.id as string, model: MODEL },
      include: { chunks: true },
    });
    expect(column.status).toBe('done');
    expect(column.chunks[0].blocks).toEqual([
      { n: 1, text: 'ES Anna arrives.' },
      { n: 2, text: 'ES — Hello, Annie.' },
    ]);
  });

  it('cancelling the compare closes unfinished columns as cancelled', async () => {
    const { ids } = await englishBook();
    const started = await start(ids.en as string, {}).expect(202);
    const opId = started.body.operation.id as string;
    await auth(http().post(`/admin/llm/operations/${opId}/cancel`)).expect(200);
    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.operation).toMatchObject({ status: 'cancelled' });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('a language with a version but outside the rights intake is refused (С5)', async () => {
    const { ids } = await book(
      [
        { language: 'en', originalLanguage: 'English', chapters: SHORT },
        { language: 'es', originalLanguage: 'English' },
      ],
      ['en', 'fr'],
    );
    const res = await start(ids.en as string, { targetLanguage: 'es' }).expect(409);
    expect(res.body).toMatchObject({ code: 'NOT_IN_INTAKE' });
    await auth(
      http().get(
        `/admin/versions/${ids.en}/translation-compare/estimate?chapterNumber=1&targetLanguage=es&models=${MODEL},${ALT}`,
      ),
    ).expect(409);
    expect(
      await prisma.llmOperation.count({ where: { kind: 'compare', bookVersionId: ids.en } }),
    ).toBe(0);
  });

  it('every model failed: the compare operation is failed, not done', async () => {
    const { ids } = await englishBook();
    answer = (name, body) =>
      name === 'translation' ? { blocks: [], glossaryFindings: [] } : defaultAnswer(name, body);
    const started = await start(ids.en as string, {}).expect(202);
    await drain();
    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.operation).toMatchObject({ status: 'failed' });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['failed', 'failed']);
  });

  it('a block left with empty inline tags gets a remark too', async () => {
    const { ids } = await englishBook();
    let translations = 0;
    answer = (name, body) => {
      if (name !== 'translation' || body.model !== MODEL) return defaultAnswer(name, body);
      translations += 1;
      const blocks = blocksOf(body);
      if (translations === 1) blocks[1] = { ...blocks[1], text: '<em> </em>&nbsp;' };
      return { blocks, glossaryFindings: [] };
    };
    await start(ids.en as string, {}).expect(202);
    await drain();
    const remark = callsOf('translation', MODEL)[1].body.messages.at(-1)?.content ?? '';
    expect(remark).toContain('blocks 2 are empty after removing markup');
  });

  it('the chapter edited after the last column finished does not turn a done compare into failed', async () => {
    const { ids } = await englishBook();
    const started = await start(ids.en as string, {}).expect(202);
    // Доводим колонки до конца, но закрытие операции оставляем следующему шагу.
    for (let i = 0; i < 40; i++) {
      const left = await prisma.translationCompareModel.count({
        where: { compareId: started.body.id as string, status: { in: ['queued', 'running'] } },
      });
      if (left === 0) break;
      await prisma.llmTask.updateMany({
        where: { status: 'pending', runAfter: { gt: new Date() } },
        data: { runAfter: new Date(Date.now() - 1000) },
      });
      await worker.runOnce();
    }
    expect(
      await prisma.llmOperation.findUniqueOrThrow({
        where: { id: started.body.operation.id as string },
      }),
    ).toMatchObject({ status: 'active' });
    await prisma.chapter.updateMany({
      where: { bookVersionId: ids.en, number: 1 },
      data: { content: '<p>Edited later.</p>' },
    });
    await drain();
    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.operation).toMatchObject({ status: 'done' });
    // Результат колонок не потерян.
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['done', 'failed']);
    expect(res.body.results[0].html).toContain('ES Anna arrives.');
  });

  it('a piece that does not fit the model context fails that column without a call', async () => {
    const { ids } = await englishBook();
    const started = await start(ids.en as string, { models: [MODEL, TINY] }).expect(202);
    await drain();
    const res = await auth(http().get(`/admin/translation-compares/${started.body.id}`)).expect(
      200,
    );
    expect(res.body.results[1]).toMatchObject({
      model: TINY,
      status: 'failed',
      error: 'COMPARE_TOO_LONG',
    });
    expect(callsOf('translation', TINY)).toHaveLength(0);
    expect(res.body.results[0]).toMatchObject({ model: MODEL, status: 'done' });
  });

  it('a limit below the dossier and glossary built first is refused before the start', async () => {
    const { ids } = await englishBook();
    const res = await start(ids.en as string, { limitUsd: '0.00000001' }).expect(400);
    expect(res.body).toMatchObject({ code: 'COMPARE_LIMIT_TOO_LOW' });
    expect(
      await prisma.llmOperation.count({ where: { kind: 'compare', bookVersionId: ids.en } }),
    ).toBe(0);
  });

  it('a dossier changed concurrently (DOSSIER_BUSY) makes the step wait, not pause', async () => {
    const { ids } = await englishBook();
    const dossiers = app.get(DossierService);
    const spy = jest
      .spyOn(dossiers, 'demandDossier')
      // Один отказ, дальше - настоящий метод: spyOn его не заменяет.
      .mockRejectedValueOnce(llmTaskConflict('DOSSIER_BUSY', 'try again'));
    const started = await start(ids.en as string, {}).expect(202);
    await worker.runOnce();
    const op = await prisma.llmOperation.findUniqueOrThrow({
      where: { id: started.body.operation.id as string },
    });
    expect(op).toMatchObject({ status: 'active', pauseReason: null });
    const task = await prisma.llmTask.findFirstOrThrow({ where: { operationId: op.id } });
    expect(task).toMatchObject({ status: 'pending', lastError: 'DOSSIER_BUSY' });
    await drain();
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } })).toMatchObject({
      status: 'done',
    });
    spy.mockRestore();
  });
});
