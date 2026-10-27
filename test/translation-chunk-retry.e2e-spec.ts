/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language, Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID } from '../src/modules/llm/llm-budget.service';
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmTaskService } from '../src/modules/llm-worker/llm-task.service';
import { LlmWorkerService } from '../src/modules/llm-worker/llm-worker.service';
import { ChapterService } from '../src/modules/chapter/chapter.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { runTaskInput } from '../src/modules/translation/run/translation-run.service';
import { chapterFingerprint } from '../src/modules/translation/source-fingerprint';
import { httpServerOf } from './http-server';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { llmCallName } from './helpers/llm-call-name';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-7v-a: куски запуска - просмотр «оригинал | перевод», повтор куска своей операцией и правка
 * руками; перезапись главы черновика по Р9. Запуск заводится напрямую и доводится исполнителем
 * до черновика (`F05-4a`..`F05-6`), `fetch` подменён, ответ модели выбирается по имени схемы.
 */
describe('Translation chunks: view, retry, edit (e2e)', () => {
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const MODEL = 'anthropic/claude-sonnet-5.5';
  /** Умолчание этапа `translate` (Р2 `F05 | F05-R`); его запасная - `MODEL`. */
  const TRANSLATOR = 'openai/gpt-5.6-terra';
  const ALT = 'z/alt-model';
  const CHECKER = 'z-ai/glm-5.3';
  const MODELS = {
    data: [
      MODEL,
      TRANSLATOR,
      ALT,
      CHECKER,
      'deepseek/deepseek-v4-pro',
      'typesafe/jev-router',
      'google/gemma-4-31b-it:free',
    ].map((id) => ({
      id,
      name: id,
      ...(id === 'typesafe/jev-router'
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
    characters: [],
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
  const GLOSSARY = { entries: [], address: [], phrases: [] };

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
  let chapters: ChapterService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();
  const slugs: string[] = [];
  const calls: Array<{ name: string; model: string }> = [];
  /** Метка перевода в ответе модели: перевод повтора отличим от перевода запуска. */
  let mark = 'RUN';
  /** Ответ перевода не по форме (блоков нет): кусок с флагом без перевода. */
  let invalid = false;
  /** Этап, все провайдеры которого отказывают по политике данных. */
  let refusedStage: string | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const targetOf = (body: ChatBody) =>
    /language code "(\w+)"/.exec(body.messages[0]?.content ?? '')?.[1] ?? '??';
  const blocksOf = (body: ChatBody) => {
    const user = body.messages[1]?.content ?? '';
    const list = user.split('Blocks to translate, as "[n] text":\n')[1] ?? '';
    return list
      .split('\n')
      .map((line) => /^\[(\d+)\] (.*)$/s.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ n: Number(m[1]), text: `${mark} ${targetOf(body).toUpperCase()} ${m[2]}` }));
  };
  const metadataAnswerOf = (body: ChatBody) => {
    const user = body.messages[1]?.content ?? '';
    const field = (label: string) => new RegExp(`^${label}: (.*)$`, 'm').exec(user)?.[1] ?? '';
    const listed = (header: string, end: string) =>
      (user.split(header)[1] ?? '')
        .split(end)[0]
        .split('\n')
        .map((line) => /^\[(\d+)\] ?(.*)$/s.exec(line))
        .filter((m): m is RegExpExecArray => m !== null);
    return {
      title: `ES ${field('Title')}`,
      author: `ES ${field('Author')}`,
      description: listed('Description blocks, as "[n] text":\n', '\n\nChapter titles').map(
        (m) => ({ n: Number(m[1]), text: `ES ${m[2]}` }),
      ),
      chapterTitles: listed('Chapter titles, as "[number] title":\n', '\nDATA>>>').map((m) => ({
        number: Number(m[1]),
        title: m[2] === '' ? '' : `ES ${m[2]}`,
      })),
    };
  };
  const answer = (name: string, body: ChatBody): unknown => {
    if (name === 'metadata') return metadataAnswerOf(body);
    if (name === 'dossier_part') return PART;
    if (name === 'dossier') return DOSSIER;
    if (name === 'glossary') return GLOSSARY;
    if (name === 'check_semantic') {
      return { verdict: 'pass', samples: [], omissions: [], nameFlags: [], remarks: [] };
    }
    if (name === 'check_seam') return { verdict: 'pass', problems: [] };
    // Jev включён по умолчанию (`F05-R`); переводы здесь испанские.
    if (name === 'check_language_jev') return { language: 'es' };
    if (name === 'final_check') return { verdict: 'pass', issues: [] };
    if (name === 'split') {
      const first = /^\[(\d+)\]/m.exec(body.messages[1]?.content ?? '');
      return { boundaryBlock: Number(first?.[1] ?? 0) };
    }
    return { blocks: invalid ? [] : blocksOf(body), glossaryFindings: [] };
  };

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

  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  /** Около 4000 слов: два куска главы. */
  const LONG = Array.from({ length: 40 }, (_, i) => `<p>Line ${i} ${words(99)}</p>`).join('');
  const SHORT = '<p>Anna arrives.</p><p>— Hello, Annie.</p>';

  /** Книга, запуск на `es` и исполнитель до черновика с записанными главами. */
  const translatedBook = async () => {
    const slug = `f057v-${stamp}-${slugs.length}`;
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
        chapters: {
          create: [
            { number: 1, title: 'One', content: LONG },
            { number: 2, title: 'Two', content: SHORT },
          ],
        },
      },
    });
    const opData = await llm.operationData({
      kind: 'translation_run',
      bookVersionId: version.id,
      limitUsd: new Prisma.Decimal('10'),
    });
    const { runId, opId } = await prisma.$transaction(async (tx) => {
      const op = await tx.llmOperation.create({ data: opData });
      const run = await tx.translationRun.create({
        data: {
          operationId: op.id,
          bookVersionId: version.id,
          sourceLanguage: 'en',
          languages: { create: [{ language: 'es' }] },
        },
        include: { languages: true },
      });
      await tx.llmOperation.update({ where: { id: op.id }, data: { translationRunId: run.id } });
      for (const l of run.languages) await tasks.enqueue(runTaskInput(l.id, l.language, op.id), tx);
      return { runId: run.id, opId: op.id };
    });
    mark = 'RUN';
    await drain();
    const lang = await prisma.translationRunLanguage.findUniqueOrThrow({
      where: { runId_language: { runId, language: 'es' as Language } },
      include: { run: true },
    });
    expect(lang).toMatchObject({ status: 'done' });
    expect(lang.bookVersionId).not.toBeNull();
    const chunks = await prisma.translationChunk.findMany({
      where: { runLanguageId: lang.id },
      orderBy: [{ chapterNumber: 'asc' }, { chunkIndex: 'asc' }],
    });
    // Вызовы запуска - не вызовы проверяемого действия.
    calls.length = 0;
    return { runId, opId, lang, chunks, draftId: lang.bookVersionId as string };
  };

  const draftChapter = (draftId: string, number: number) =>
    prisma.chapter.findUniqueOrThrow({
      where: { bookVersionId_number: { bookVersionId: draftId, number } },
    });
  const chapterRow = (languageId: string, number: number) =>
    prisma.translationChapter.findUniqueOrThrow({
      where: { runLanguageId_chapterNumber: { runLanguageId: languageId, chapterNumber: number } },
    });

  const drain = async () => {
    for (let i = 0; i < 600; i++) {
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
    chapters = app.get(ChapterService);
    const adminEmail = `f057v-admin-${stamp}@test.com`;
    const cmEmail = `f057v-cm-${stamp}@test.com`;
    await register(adminEmail);
    await register(cmEmail);
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    tokens.admin = await login(adminEmail);
    tokens.cm = await login(cmEmail);
    // Вошедший без ролей: U6 - 403 на каждой ручке фичи.
    const userEmail = `f057v-user-${stamp}@test.com`;
    await register(userEmail);
    tokens.user = await login(userEmail);
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    calls.length = 0;
    invalid = false;
    refusedStage = null;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((url, init) => {
      if (urlOf(url).endsWith('/models')) return Promise.resolve(json(MODELS));
      if (urlOf(url).endsWith('/chat/completions')) {
        const body = JSON.parse((init as RequestInit).body as string) as ChatBody;
        const name = llmCallName(body);
        calls.push({ name, model: body.model });
        if (name === refusedStage) {
          return Promise.resolve(
            json(
              { error: { code: 404, message: 'No endpoints found matching your data policy' } },
              404,
            ),
          );
        }
        return Promise.resolve(
          json({
            model: body.model,
            provider: 'E2EProvider',
            choices: [{ message: { content: JSON.stringify(answer(name, body)) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0001 },
          }),
        );
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

  it('401 without a token, 403 for a content manager and a user without roles on every route', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const routes: Array<['get' | 'post' | 'put', string]> = [
      ['get', `/admin/translation-runs/${id}/chunks?lang=es&chapter=1`],
      ['post', `/admin/translation-chunks/${id}/retry`],
      ['put', `/admin/translation-chunks/${id}`],
    ];
    for (const [method, path] of routes) {
      await http()[method](path).expect(401);
      await auth(http()[method](path), 'cm').expect(403);
      await auth(http()[method](path), 'user').expect(403);
    }
    await auth(http().get(`/admin/translation-runs/${id}/chunks?lang=es&chapter=1`)).expect(404);
  });

  it('chunks of a chapter: source and translation block to block, no model answer, verdict or call id', async () => {
    const { runId } = await translatedBook();
    const res = await auth(
      http().get(`/admin/translation-runs/${runId}/chunks?lang=es&chapter=1`),
    ).expect(200);
    expect(res.body).toMatchObject({
      runId,
      language: 'es',
      chapterNumber: 1,
      sourceChanged: false,
    });
    expect(res.body.chapter).toMatchObject({ status: 'written', rewriteRefusal: null });
    expect(res.body.chunks).toHaveLength(2);
    const [first] = res.body.chunks as Array<Record<string, unknown>>;
    expect(Object.keys(first).sort()).toEqual(
      [
        'attempts',
        'remarks',
        'blocks',
        'chunkIndex',
        'costUsd',
        'editedAt',
        'firstBlock',
        'flagReason',
        'id',
        'lastBlock',
        'model',
        'retry',
        'status',
      ].sort(),
    );
    expect(first).toMatchObject({
      status: 'done',
      model: TRANSLATOR,
      retry: null,
      editedAt: null,
    });
    expect((first.blocks as unknown[])[0]).toEqual({
      n: 1,
      source: expect.stringContaining('Line 0') as unknown,
      translation: expect.stringContaining('RUN ES Line 0') as unknown,
    });
    // Глава без кусков (номера нет) - пусто, а не отказ.
    const none = await auth(
      http().get(`/admin/translation-runs/${runId}/chunks?lang=es&chapter=99`),
    ).expect(200);
    expect(none.body).toMatchObject({ chapter: null, chunks: [] });
    await auth(http().get(`/admin/translation-runs/${runId}/chunks?lang=fr&chapter=1`)).expect(404);
  });

  it('a retry with another model: new translation and model on the piece, its own operation pays, two retries of one chapter both rewrite it', async () => {
    const { opId, lang, chunks, draftId } = await translatedBook();
    const runSpent = (await prisma.llmOperation.findUniqueOrThrow({ where: { id: opId } }))
      .spentUsd;
    mark = 'R1';
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ model: ALT, limitUsd: '1' })
      .expect(202);
    expect(res.body.operation).toMatchObject({ kind: 'translation_retry', status: 'active' });
    expect(res.body.chunk.retry).toMatchObject({ status: 'pending', requestedModel: ALT });
    await drain();

    const retried = await prisma.translationChunk.findUniqueOrThrow({
      where: { id: chunks[0].id },
    });
    expect(retried).toMatchObject({ status: 'done', model: ALT, attempts: 2 });
    expect(JSON.stringify(retried.blocks)).toContain('R1 ES Line 0');
    const retryOpId = res.body.operation.id as string;
    expect(retried.retry).toMatchObject({ status: 'applied', operationId: retryOpId });
    const retryOp = await prisma.llmOperation.findUniqueOrThrow({ where: { id: retryOpId } });
    expect(retryOp).toMatchObject({ status: 'done', translationRunId: lang.runId });
    expect(retryOp.spentUsd.gt(0)).toBe(true);
    // Повтор платит своей операцией: траты запуска не выросли.
    expect((await prisma.llmOperation.findUniqueOrThrow({ where: { id: opId } })).spentUsd).toEqual(
      runSpent,
    );
    expect(calls.filter((c) => c.name === 'translation').map((c) => c.model)).toEqual([ALT]);

    let chapter = await draftChapter(draftId, 1);
    expect(chapter.content).toContain('R1 ES Line 0');
    expect(chapter.content).toContain('RUN ES Line 39');
    expect((await chapterRow(lang.id, 1)).writtenHash).toBe(chapterFingerprint(chapter.content));

    // Второй повтор другого куска той же главы - глава переписана снова (хэш обновлён первым).
    mark = 'R2';
    await auth(http().post(`/admin/translation-chunks/${chunks[1].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    await drain();
    chapter = await draftChapter(draftId, 1);
    expect(chapter.content).toContain('R1 ES Line 0');
    expect(chapter.content).toContain('R2 ES Line 39');
    expect(await chapterRow(lang.id, 1)).toMatchObject({
      writtenHash: chapterFingerprint(chapter.content),
      rewriteRefusal: null,
    });

    // Отчёт: ответы моделей стыков к тексту до повтора - `stale`, глава без отказа перезаписи;
    // ход запуска - операции досье и глоссариев, без повторов кусков.
    const report = await auth(http().get(`/admin/translation-runs/${lang.runId}/report`)).expect(
      200,
    );
    const reported = (
      report.body.languages[0].chapters as Array<{
        number: number;
        rewriteRefusal: string | null;
        findings: Array<{ code: string; stale?: boolean }>;
      }>
    ).find((c) => c.number === 1)!;
    expect(reported.rewriteRefusal).toBeNull();
    expect(reported.findings.filter((f) => f.code === 'SEAM_CHECKED')).toEqual([
      expect.objectContaining({ stale: true }),
    ]);
    const run = await auth(http().get(`/admin/translation-runs/${lang.runId}`)).expect(200);
    expect(
      (run.body.operations as Array<{ kind: string }>).every((o) => o.kind === 'dossier'),
    ).toBe(true);
  });

  it('a retry that hit its limit pauses its own operation and leaves the piece as it was; resume with a new limit finishes it', async () => {
    const { lang, chunks } = await translatedBook();
    mark = 'R3';
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '0.00000001' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    await drain();
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: retryOpId } })).toMatchObject(
      {
        status: 'paused',
        pauseReason: 'LIMIT_REACHED',
      },
    );
    const waiting = await prisma.translationChunk.findUniqueOrThrow({
      where: { id: chunks[2].id },
    });
    expect(waiting).toMatchObject({ status: 'done', blocks: chunks[2].blocks });
    expect(waiting.retry).toMatchObject({ status: 'pending', operationId: retryOpId });
    // Экран видит паузу повтора, её причину и траты - выход «продолжить с новым лимитом».
    const view = await auth(
      http().get(`/admin/translation-runs/${lang.runId}/chunks?lang=es&chapter=2`),
    ).expect(200);
    expect(view.body.chunks[0].retry).toMatchObject({
      status: 'pending',
      operationStatus: 'paused',
      pauseReason: 'LIMIT_REACHED',
      limitUsd: '0.00000001',
    });

    // Запуск снова идёт - «продолжить» повтора отказывает: шаг запуска переводит тот же язык.
    const runOp = (await prisma.translationRun.findUniqueOrThrow({ where: { id: lang.runId } }))
      .operationId;
    await prisma.llmOperation.update({ where: { id: runOp }, data: { status: 'active' } });
    const refused = await auth(http().post(`/admin/llm/operations/${retryOpId}/resume`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(refused.body.code).toBe('RUN_ACTIVE');
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: retryOpId } })).toMatchObject(
      { status: 'paused' },
    );
    await prisma.llmOperation.update({ where: { id: runOp }, data: { status: 'done' } });

    await auth(http().post(`/admin/llm/operations/${retryOpId}/resume`))
      .send({ limitUsd: '1' })
      .expect(200);
    await drain();
    const done = await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunks[2].id } });
    expect(JSON.stringify(done.blocks)).toContain('R3 ES');
    expect(done.retry).toMatchObject({ status: 'applied' });
    expect((await chapterRow(lang.id, 2)).rewriteRefusal).toBeNull();
  });

  it('a retry while the run is running - 409 RUN_ACTIVE; resume of the run while a retry is queued - 409 RETRY_IN_PROGRESS; a hand edit then - RETRY_IN_PROGRESS', async () => {
    const { runId, opId, chunks } = await translatedBook();
    await prisma.llmOperation.update({ where: { id: opId }, data: { status: 'active' } });
    const active = await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(active.body.code).toBe('RUN_ACTIVE');
    expect(
      await prisma.llmOperation.count({
        where: { kind: 'translation_retry', translationRunId: runId },
      }),
    ).toBe(0);

    await prisma.llmOperation.update({ where: { id: opId }, data: { status: 'paused' } });
    await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const resumed = await auth(http().post(`/admin/translation-runs/${runId}/resume`))
      .send({})
      .expect(409);
    expect(resumed.body.code).toBe('RETRY_IN_PROGRESS');
    const second = await auth(http().post(`/admin/translation-chunks/${chunks[1].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(second.body.code).toBe('RETRY_IN_PROGRESS');
    const edit = await auth(http().put(`/admin/translation-chunks/${chunks[2].id}`))
      .send({
        blocks: [
          { n: 1, text: 'x' },
          { n: 2, text: 'y' },
        ],
      })
      .expect(409);
    expect(edit.body.code).toBe('RETRY_IN_PROGRESS');
  });

  it('a hand edit: the piece is saved and marked, the chapter is rewritten; edited chapter or published version - 200 with the reason, the chapter untouched', async () => {
    const { lang, chunks, draftId } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    // Замечания проверяющего к прежнему тексту: правка руками их снимает.
    await prisma.translationChunk.update({
      where: { id: short.id },
      data: {
        verdict: { seed: 1, failures: 1, remarks: ['Name lost'], attempts: [] },
      },
    });
    const staleness = jest.spyOn(app.get(RightsContentHashService), 'checkVersionStaleness');
    const edited = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({
        blocks: [
          { n: 1, text: 'Ana <strong>llega</strong>.<script>x</script>' },
          { n: 2, text: '— Hola, Annie.' },
        ],
      })
      .expect(200);
    expect(edited.body).toMatchObject({ chapterRewritten: true, reason: null });
    // Перезапись главы помечает версию черновика тем же путём, что ручное сохранение: правовой
    // учёт текста (D3) - в транзакции записи (`tx` пятым аргументом), а не после неё.
    expect(staleness).toHaveBeenCalledTimes(1);
    expect(staleness).toHaveBeenCalledWith(
      draftId,
      'CHAPTER_UPDATED',
      null,
      true,
      expect.anything(),
    );
    staleness.mockRestore();
    expect(edited.body.chunk.editedAt).not.toBeNull();
    expect(edited.body.chunk.remarks).toEqual([]);
    expect(edited.body.chunk.blocks[0].translation).toBe('Ana <strong>llega</strong>.');
    let chapter = await draftChapter(draftId, 2);
    expect(chapter.content).toBe('<p>Ana <strong>llega</strong>.</p><p>— Hola, Annie.</p>');

    // Редактор правил главу черновика - правка куска её не трогает, кусок обновлён.
    await chapters.update(chapter.id, { content: '<p>Editor text.</p>' });
    const refused = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({
        blocks: [
          { n: 1, text: 'Ana llega otra vez.' },
          { n: 2, text: '— Hola.' },
        ],
      })
      .expect(200);
    expect(refused.body).toMatchObject({
      chapterRewritten: false,
      reason: 'CHAPTER_EDITED_MANUALLY',
    });
    expect(refused.body.chunk.blocks[0].translation).toBe('Ana llega otra vez.');
    chapter = await draftChapter(draftId, 2);
    expect(chapter.content).toBe('<p>Editor text.</p>');
    expect(await chapterRow(lang.id, 2)).toMatchObject({
      rewriteRefusal: 'CHAPTER_EDITED_MANUALLY',
    });

    // Версия опубликована - глава 1 не трогается.
    await prisma.bookVersion.update({ where: { id: draftId }, data: { status: 'published' } });
    const before = (await draftChapter(draftId, 1)).content;
    const first = chunks.find((c) => c.chapterNumber === 1 && c.chunkIndex === 0)!;
    const blocks = ((first.blocks ?? []) as Array<{ n: number; text: string }>).map((b) => ({
      n: b.n,
      text: `${b.text} edited`,
    }));
    const published = await auth(http().put(`/admin/translation-chunks/${first.id}`))
      .send({ blocks })
      .expect(200);
    expect(published.body).toMatchObject({ chapterRewritten: false, reason: 'VERSION_NOT_DRAFT' });
    expect((await draftChapter(draftId, 1)).content).toBe(before);
  });

  it('a hand edit with blocks not of the piece or empty after markup cleaning - 400 CHUNK_BLOCKS_INVALID, nothing saved', async () => {
    const { chunks } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    for (const blocks of [
      [{ n: 1, text: 'Uno.' }],
      [
        { n: 1, text: 'Uno.' },
        { n: 2, text: 'Dos.' },
        { n: 3, text: 'Tres.' },
      ],
      [
        { n: 1, text: '<script>x</script>' },
        { n: 2, text: 'Dos.' },
      ],
    ]) {
      const res = await auth(http().put(`/admin/translation-chunks/${short.id}`))
        .send({ blocks })
        .expect(400);
      expect(res.body.code).toBe('CHUNK_BLOCKS_INVALID');
    }
    expect(
      await prisma.translationChunk.findUniqueOrThrow({ where: { id: short.id } }),
    ).toMatchObject({ editedAt: null, blocks: short.blocks });
  });

  it('a flagged piece fixed by hand: the flag and the piece counter go away; a chapter not written creates the draft chapter', async () => {
    const { lang, chunks, draftId } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    // Глава 2 не записалась: кусок без перевода (как `CHUNK_TOO_LONG`), главы в черновике нет.
    await prisma.$transaction([
      prisma.translationChunk.update({
        where: { id: short.id },
        data: { status: 'flagged', flagReason: 'CHUNK_TOO_LONG', blocks: [] },
      }),
      prisma.chapter.delete({
        where: { bookVersionId_number: { bookVersionId: draftId, number: 2 } },
      }),
      prisma.translationChapter.update({
        where: { runLanguageId_chapterNumber: { runLanguageId: lang.id, chapterNumber: 2 } },
        data: {
          status: 'flagged',
          flagReason: 'CHUNK_UNTRANSLATED',
          chapterId: null,
          writtenHash: null,
          findings: [{ code: 'CHUNK_UNTRANSLATED', chunkIndex: 0 }, { code: 'FINAL_CHECKED' }],
        },
      }),
      prisma.translationRunLanguage.update({
        where: { id: lang.id },
        data: { flaggedChunks: 1, flaggedChapters: 1 },
      }),
    ]);
    const res = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({
        blocks: [
          { n: 1, text: 'Ana llega.' },
          { n: 2, text: '— Hola, Annie.' },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({ chapterRewritten: true, reason: null });
    expect(res.body.chunk).toMatchObject({ status: 'done', flagReason: null });
    const created = await draftChapter(draftId, 2);
    expect(created).toMatchObject({
      title: 'ES Two',
      content: '<p>Ana llega.</p><p>— Hola, Annie.</p>',
    });
    expect(await chapterRow(lang.id, 2)).toMatchObject({
      status: 'written',
      chapterId: created.id,
      flagReason: null,
      findings: [{ code: 'FINAL_CHECKED', stale: true }],
    });
    expect(
      await prisma.translationRunLanguage.findUniqueOrThrow({ where: { id: lang.id } }),
    ).toMatchObject({ flaggedChunks: 0, flaggedChapters: 0 });
  });

  it('a language finished without a draft - 409 DRAFT_MISSING before any spending', async () => {
    const { lang, chunks } = await translatedBook();
    await prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { status: 'failed', reason: 'DRAFT_DELETED', bookVersionId: null },
    });
    const retry = await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(retry.body.code).toBe('DRAFT_MISSING');
    const edit = await auth(http().put(`/admin/translation-chunks/${chunks[2].id}`))
      .send({
        blocks: [
          { n: 1, text: 'x' },
          { n: 2, text: 'y' },
        ],
      })
      .expect(409);
    expect(edit.body.code).toBe('DRAFT_MISSING');
    expect(calls.filter((c) => c.name === 'translation')).toHaveLength(0);
  });

  it('a chapter assembled but not yet written (the language still runs, no draft): findings rebuilt from the new pieces, the run writes it', async () => {
    const { lang, chunks, draftId } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    await prisma.$transaction([
      prisma.bookVersion.delete({ where: { id: draftId } }),
      prisma.translationRunLanguage.update({
        where: { id: lang.id },
        data: {
          status: 'running',
          bookVersionId: null,
          draftCreatedAt: null,
          flaggedChunks: 1,
          flaggedChapters: 1,
        },
      }),
      prisma.translationChunk.update({
        where: { id: short.id },
        data: { status: 'flagged', flagReason: 'NOT_INDEPENDENT' },
      }),
      prisma.translationChapter.update({
        where: { runLanguageId_chapterNumber: { runLanguageId: lang.id, chapterNumber: 2 } },
        data: {
          status: 'assembled',
          flagReason: 'CHUNK_FLAGGED',
          chapterId: null,
          writtenHash: null,
          findings: [{ code: 'CHUNK_FLAGGED', chunkIndex: 0, chunkReason: 'NOT_INDEPENDENT' }],
        },
      }),
    ]);
    const res = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({
        blocks: [
          { n: 1, text: 'Ana llega.' },
          { n: 2, text: '— Hola.' },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({ chapterRewritten: false, reason: null });
    expect(await chapterRow(lang.id, 2)).toMatchObject({
      status: 'assembled',
      flagReason: null,
      findings: [],
      rewriteRefusal: null,
    });
    expect(
      await prisma.translationRunLanguage.findUniqueOrThrow({ where: { id: lang.id } }),
    ).toMatchObject({ flaggedChunks: 0, flaggedChapters: 0 });
  });

  it('the draft deleted while a retry runs: the piece is replaced, the chapter carries DRAFT_DELETED', async () => {
    const { lang, chunks, draftId } = await translatedBook();
    mark = 'RD';
    await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    await prisma.bookVersion.delete({ where: { id: draftId } });
    await drain();
    const chunk = await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunks[2].id } });
    expect(JSON.stringify(chunk.blocks)).toContain('RD ES');
    expect(chunk.retry).toMatchObject({ status: 'applied' });
    expect((await chapterRow(lang.id, 2)).rewriteRefusal).toBe('DRAFT_DELETED');
  });

  it('resume of a paused retry whose own step is still running: success without a second task', async () => {
    const { chunks } = await translatedBook();
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    // Пауза пришла, пока шаг повтора держал пару (`running`, аренда живая): задача - своя.
    await prisma.llmOperation.update({
      where: { id: retryOpId },
      data: { status: 'paused', pauseReason: 'LIMIT_REACHED' },
    });
    await prisma.llmTask.updateMany({
      where: { operationId: retryOpId },
      data: { status: 'running', leaseUntil: new Date(Date.now() + 60_000), ownerToken: 'other' },
    });
    await auth(http().post(`/admin/llm/operations/${retryOpId}/resume`))
      .send({ limitUsd: '1' })
      .expect(200);
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: retryOpId } })).toMatchObject(
      { status: 'active' },
    );
    expect(await prisma.llmTask.count({ where: { operationId: retryOpId } })).toBe(1);
  });

  it('a retry with a model of the same family as every meaning check model - 409 CHECK_MODEL_SAME_FAMILY, no operation', async () => {
    const { lang, chunks } = await translatedBook();
    // Сверка смысла запуска - одна модель того же семейства, что модель повтора.
    const run = await prisma.translationRun.findUniqueOrThrow({ where: { id: lang.runId } });
    await prisma.translationRun.update({
      where: { id: run.id },
      data: { stageModels: { check_semantic: 'z/alt-model' } },
    });
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ model: ALT, limitUsd: '1' })
      .expect(409);
    expect(res.body.code).toBe('CHECK_MODEL_SAME_FAMILY');
    expect(
      await prisma.llmOperation.count({
        where: { kind: 'translation_retry', translationRunId: lang.runId },
      }),
    ).toBe(0);
  });

  it('a published version and a chapter never written: the edit is refused VERSION_NOT_DRAFT, the chapter findings follow the new pieces', async () => {
    const { lang, chunks, draftId } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    await prisma.$transaction([
      prisma.translationChunk.update({
        where: { id: short.id },
        data: { status: 'flagged', flagReason: 'CHUNK_TOO_LONG', blocks: [] },
      }),
      prisma.chapter.delete({
        where: { bookVersionId_number: { bookVersionId: draftId, number: 2 } },
      }),
      prisma.translationChapter.update({
        where: { runLanguageId_chapterNumber: { runLanguageId: lang.id, chapterNumber: 2 } },
        data: {
          status: 'flagged',
          flagReason: 'CHUNK_UNTRANSLATED',
          chapterId: null,
          writtenHash: null,
          findings: [{ code: 'CHUNK_UNTRANSLATED', chunkIndex: 0 }],
        },
      }),
      prisma.translationRunLanguage.update({
        where: { id: lang.id },
        data: { flaggedChunks: 1, flaggedChapters: 1 },
      }),
      prisma.bookVersion.update({ where: { id: draftId }, data: { status: 'published' } }),
    ]);
    const res = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({
        blocks: [
          { n: 1, text: 'Ana llega.' },
          { n: 2, text: '— Hola.' },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({ chapterRewritten: false, reason: 'VERSION_NOT_DRAFT' });
    // Находки - по новым кускам (кусок без перевода ушёл), флаг - почему главы нет в черновике.
    expect(await chapterRow(lang.id, 2)).toMatchObject({
      status: 'flagged',
      flagReason: 'VERSION_NOT_DRAFT',
      findings: [],
      rewriteRefusal: 'VERSION_NOT_DRAFT',
    });
    expect(
      await prisma.translationRunLanguage.findUniqueOrThrow({ where: { id: lang.id } }),
    ).toMatchObject({ flaggedChunks: 0, flaggedChapters: 1 });
  });

  it('every meaning check provider refuses during a retry: its operation pauses, the attempt names the stage and the models', async () => {
    const { lang, chunks } = await translatedBook();
    refusedStage = 'check_semantic';
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    await drain();
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: retryOpId } })).toMatchObject(
      { status: 'paused', pauseReason: 'NO_COMPLIANT_PROVIDER' },
    );
    const view = await auth(
      http().get(`/admin/translation-runs/${lang.runId}/chunks?lang=es&chapter=2`),
    ).expect(200);
    expect(view.body.chunks[0].retry).toMatchObject({
      status: 'translated',
      operationStatus: 'paused',
      reason: 'CHECK_NO_COMPLIANT_PROVIDER',
      reasonModels: [CHECKER, 'deepseek/deepseek-v4-pro'],
    });
  });

  it('a hand edit over a retry paused on providers: the retry is cancelled, its paid answers stay in the piece cost', async () => {
    const { chunks } = await translatedBook();
    refusedStage = 'check_semantic';
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    await drain();
    const paused = await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunks[2].id } });
    const paid = (paused.retry as { costUsd: string }).costUsd;
    expect(Number(paid)).toBeGreaterThan(0);
    await auth(http().put(`/admin/translation-chunks/${chunks[2].id}`))
      .send({
        blocks: [
          { n: 1, text: 'Ana llega.' },
          { n: 2, text: '— Hola.' },
        ],
      })
      .expect(200);
    const edited = await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunks[2].id } });
    expect(edited.retry).toBeNull();
    expect(edited.costUsd!.toString()).toBe(chunks[2].costUsd!.add(paid).toString());
    expect(edited.attempts).toBe(chunks[2].attempts + 1);
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: retryOpId } })).toMatchObject(
      { status: 'cancelled' },
    );
  });

  it('resume of a retry paused on providers clears the stage and models of the pause', async () => {
    const { lang, chunks } = await translatedBook();
    refusedStage = 'check_semantic';
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    await drain();
    refusedStage = null;
    await auth(http().post(`/admin/llm/operations/${retryOpId}/resume`))
      .send({})
      .expect(200);
    const view = await auth(
      http().get(`/admin/translation-runs/${lang.runId}/chunks?lang=es&chapter=2`),
    ).expect(200);
    expect(view.body.chunks[0].retry).toMatchObject({
      operationStatus: 'active',
      reason: null,
      reasonModels: [],
    });
  });

  it('resume of a retry while another retry of the language holds the pair - 409 RETRY_IN_PROGRESS; while a run step holds it - 409 RUN_ACTIVE', async () => {
    const { lang, opId, chunks } = await translatedBook();
    const first = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '0.00000001' })
      .expect(202);
    const pausedOp = first.body.operation.id as string;
    await drain();
    expect(await prisma.llmOperation.findUniqueOrThrow({ where: { id: pausedOp } })).toMatchObject({
      status: 'paused',
    });
    // Повтор другого куска того же языка занимает пару.
    await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const busy = await auth(http().post(`/admin/llm/operations/${pausedOp}/resume`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(busy.body.code).toBe('RETRY_IN_PROGRESS');

    // Пару держит шаг запуска, который доделывается после паузы.
    await prisma.llmTask.updateMany({
      where: {
        status: { in: ['pending', 'running'] },
        operation: { translationRunId: lang.runId },
      },
      data: { status: 'cancelled' },
    });
    await prisma.llmTask.create({
      data: {
        kind: 'translation_run',
        operationId: opId,
        language: 'es',
        pairKey: `${opId}:es`,
        status: 'running',
        leaseUntil: new Date(Date.now() + 60_000),
        ownerToken: 'other',
        payload: {},
      },
    });
    const stepping = await auth(http().post(`/admin/llm/operations/${pausedOp}/resume`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(stepping.body.code).toBe('RUN_ACTIVE');
  });

  it('a cancelled retry closes its attempt: the piece stays, the attempt is failed RETRY_CANCELLED', async () => {
    const { lang, chunks } = await translatedBook();
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    await auth(http().post(`/admin/llm/operations/${retryOpId}/cancel`)).expect(200);
    const view = await auth(
      http().get(`/admin/translation-runs/${lang.runId}/chunks?lang=es&chapter=2`),
    ).expect(200);
    expect(view.body.chunks[0]).toMatchObject({
      status: 'done',
      retry: { status: 'failed', reason: 'RETRY_CANCELLED', operationStatus: 'cancelled' },
    });
    expect(view.body.chunks[0].blocks[0].translation).toContain('RUN ES');
  });

  it('a retry whose answer is not of the form fails without replacing the piece', async () => {
    const { lang, chunks } = await translatedBook();
    invalid = true;
    await auth(http().post(`/admin/translation-chunks/${chunks[2].id}/retry`))
      .send({ limitUsd: '1' })
      .expect(202);
    await drain();
    const chunk = await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunks[2].id } });
    expect(chunk).toMatchObject({ status: 'done', blocks: chunks[2].blocks });
    expect(chunk.retry).toMatchObject({ status: 'failed', reason: 'CHUNK_INVALID_RESPONSE' });
    // Оплаченные ответы неудачной попытки - в стоимости и попытках куска.
    const attempt = chunk.retry as { costUsd: string };
    expect(chunk.costUsd!.toString()).toBe(chunks[2].costUsd!.add(attempt.costUsd).toString());
    expect(chunk.attempts).toBe(chunks[2].attempts + 1);
    expect(
      await prisma.translationRunLanguage.findUniqueOrThrow({ where: { id: lang.id } }),
    ).toMatchObject({ flaggedChunks: 0 });
  });

  it('a retry whose executor died after the model answer was saved, before the step finished, is not paid again (product.md §7 п.5)', async () => {
    const { chunks } = await translatedBook();
    mark = 'R1';
    const res = await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ model: ALT, limitUsd: '1' })
      .expect(202);
    const retryOpId = res.body.operation.id as string;
    const retryOf = async () =>
      (await prisma.translationChunk.findUniqueOrThrow({ where: { id: chunks[0].id } })).retry as {
        status: string;
      } | null;
    // Шаги по одному, пока ответ модели не записан в попытку.
    for (let i = 0; i < 50 && (await retryOf())?.status !== 'translated'; i++) {
      await worker.runOnce();
    }
    expect(await retryOf()).toMatchObject({ status: 'translated' });
    const paid = calls.filter((c) => c.name === 'translation');
    expect(paid).toHaveLength(1);

    // Исполнитель умер после записи ответа, до итога шага: аренда чужая и истекла.
    const killed = await prisma.llmTask.updateMany({
      where: { operationId: retryOpId, status: { in: ['pending', 'running'] } },
      data: { status: 'running', ownerToken: 'dead', leaseUntil: new Date(Date.now() - 1000) },
    });
    // Падение и правда подложено: задача повтора есть и перехватывается чужой арендой.
    expect(killed.count).toBe(1);
    await drain();

    expect(calls.filter((c) => c.name === 'translation')).toHaveLength(1);
    const retried = await prisma.translationChunk.findUniqueOrThrow({
      where: { id: chunks[0].id },
    });
    expect(retried).toMatchObject({ status: 'done', model: ALT });
    expect(retried.retry).toMatchObject({ status: 'applied', operationId: retryOpId });
    expect(
      await prisma.llmCall.count({ where: { operationId: retryOpId, stage: 'translate' } }),
    ).toBe(1);
    // Ни один этап повтора не оплачен дважды: проверки после перехвата тоже идут по одному разу.
    const perStage = await prisma.llmCall.groupBy({
      by: ['stage'],
      where: { operationId: retryOpId },
      _count: { _all: true },
    });
    expect(perStage.filter((s) => s._count._all !== 1)).toEqual([]);
  });

  it('the source chapter edited after the split - 409 CHUNK_SOURCE_CHANGED on retry and edit, before any spending', async () => {
    const { chunks } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    const run = await prisma.translationRun.findFirstOrThrow({
      where: { languages: { some: { id: short.runLanguageId } } },
    });
    await prisma.chapter.update({
      where: { bookVersionId_number: { bookVersionId: run.bookVersionId, number: 2 } },
      data: { content: '<p>Anna leaves.</p>' },
    });
    const retry = await auth(http().post(`/admin/translation-chunks/${short.id}/retry`))
      .send({ limitUsd: '1' })
      .expect(409);
    expect(retry.body.code).toBe('CHUNK_SOURCE_CHANGED');
    const edit = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({ blocks: [{ n: 1, text: 'x' }] })
      .expect(409);
    expect(edit.body.code).toBe('CHUNK_SOURCE_CHANGED');
    expect(
      await prisma.llmOperation.count({
        where: { kind: 'translation_retry', translationRunId: run.id },
      }),
    ).toBe(0);
  });

  it('a retry with an unknown model or a bad limit - 400, no operation', async () => {
    const { lang, chunks } = await translatedBook();
    const unknown = await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
      .send({ model: 'nope/none', limitUsd: '1' })
      .expect(400);
    expect(unknown.body.code).toBe('LLM_MODEL_UNKNOWN');
    for (const limitUsd of ['-5', 'abc']) {
      await auth(http().post(`/admin/translation-chunks/${chunks[0].id}/retry`))
        .send({ limitUsd })
        .expect(400);
    }
    expect(
      await prisma.llmOperation.count({
        where: { kind: 'translation_retry', translationRunId: lang.runId },
      }),
    ).toBe(0);
  });

  it('a draft deleted while the language is still running - 409 DRAFT_MISSING', async () => {
    const { lang, chunks } = await translatedBook();
    await prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { status: 'running', bookVersionId: null },
    });
    const edit = await auth(http().put(`/admin/translation-chunks/${chunks[2].id}`))
      .send({
        blocks: [
          { n: 1, text: 'x' },
          { n: 2, text: 'y' },
        ],
      })
      .expect(409);
    expect(edit.body.code).toBe('DRAFT_MISSING');
  });

  it('a chapter created by an edit: TITLE_MISSING only when the source chapter has a title', async () => {
    for (const sourceTitle of ['Two', '']) {
      const { lang, chunks, draftId } = await translatedBook();
      const short = chunks.find((c) => c.chapterNumber === 2)!;
      await prisma.$transaction([
        prisma.chapter.update({
          where: { bookVersionId_number: { bookVersionId: lang.run.bookVersionId, number: 2 } },
          data: { title: sourceTitle },
        }),
        prisma.chapter.delete({
          where: { bookVersionId_number: { bookVersionId: draftId, number: 2 } },
        }),
        prisma.translationChapter.update({
          where: { runLanguageId_chapterNumber: { runLanguageId: lang.id, chapterNumber: 2 } },
          data: {
            status: 'flagged',
            flagReason: 'CHUNK_UNTRANSLATED',
            chapterId: null,
            writtenHash: null,
            findings: [],
          },
        }),
        // Названия главы 2 нет в ответе `metadata`.
        prisma.translationRunLanguage.update({
          where: { id: lang.id },
          data: {
            flaggedChapters: 1,
            metadata: {
              attempts: [],
              result: {
                title: 'T',
                author: 'A',
                authorFromGlossary: true,
                description: '',
                chapterTitles: [],
              },
            },
          },
        }),
      ]);
      await auth(http().put(`/admin/translation-chunks/${short.id}`))
        .send({
          blocks: [
            { n: 1, text: 'Ana llega.' },
            { n: 2, text: '— Hola.' },
          ],
        })
        .expect(200);
      const row = await chapterRow(lang.id, 2);
      expect(row.status).toBe('written');
      expect(row.flagReason).toBe(sourceTitle === '' ? null : 'TITLE_MISSING');
    }
  });

  it('a hand save of the draft chapter holding its transaction: the piece edit waits and is refused, the editor text stays', async () => {
    const { chunks, draftId } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    const chapter = await draftChapter(draftId, 2);
    // Сохранение редактора держит транзакцию (строку главы и замок прав) дольше, чем идёт
    // правка куска: перезапись обязана дождаться его и увидеть новый текст.
    const hashes = app.get(RightsContentHashService);
    type Check = RightsContentHashService['checkVersionStaleness'];
    const real = hashes.checkVersionStaleness.bind(hashes) as unknown as Check;
    let held = false;
    jest.spyOn(hashes, 'checkVersionStaleness').mockImplementation(async (...args) => {
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return real(...args);
    });
    const save = chapters.update(chapter.id, { content: '<p>Editor held.</p>' });
    await new Promise((r) => setTimeout(r, 300));
    const res = await auth(http().put(`/admin/translation-chunks/${short.id}`))
      .send({
        blocks: [
          { n: 1, text: 'Piece.' },
          { n: 2, text: '— Hola.' },
        ],
      })
      .expect(200);
    await save;
    expect(res.body).toMatchObject({ chapterRewritten: false, reason: 'CHAPTER_EDITED_MANUALLY' });
    expect((await draftChapter(draftId, 2)).content).toBe('<p>Editor held.</p>');
  });

  it('a hand save of the draft chapter racing a piece edit: one of the two goes through, the editor text is never overwritten', async () => {
    const { chunks, draftId } = await translatedBook();
    const short = chunks.find((c) => c.chapterNumber === 2)!;
    for (let i = 0; i < 4; i++) {
      const chapter = await draftChapter(draftId, 2);
      const [, res] = await Promise.all([
        chapters.update(chapter.id, { content: `<p>Editor ${i}.</p>` }),
        auth(http().put(`/admin/translation-chunks/${short.id}`))
          .send({
            blocks: [
              { n: 1, text: `Piece ${i}.` },
              { n: 2, text: '— Hola.' },
            ],
          })
          .expect(200),
      ]);
      // Сохранение редактора - либо после перезаписи (его текст последний), либо до неё (отказ).
      expect((await draftChapter(draftId, 2)).content).toBe(`<p>Editor ${i}.</p>`);
      if (!res.body.chapterRewritten) expect(res.body.reason).toBe('CHAPTER_EDITED_MANUALLY');
    }
  });
});
