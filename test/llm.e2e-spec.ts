import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LLM_BUDGET_ID, LlmBudgetService } from '../src/modules/llm/llm-budget.service';
import { LlmStageRegistry } from '../src/modules/llm/llm-stages.registry';
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmBudgetExceededError } from '../src/modules/llm/llm.errors';
import { httpServerOf } from './http-server';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * F05-1: модуль LLM. Ручки настроек - только `admin` (U6). Ни одна ручка модель не зовёт,
 * поэтому вызов проверяется сервисом внутри поднятого приложения, а бюджет меняется настоящим
 * HTTP `PUT` (решение арбитра `F05 | F05-1`, В3). Внешний `fetch` подменён всегда: в настоящий
 * OpenRouter тест не ходит.
 */
describe('LLM module (e2e)', () => {
  const STAGE = 'e2e_test_stage';
  const FAKE_KEY = 'sk-or-e2e-fake-key';
  const MODELS = {
    data: [
      { id: 'a/priced', name: 'Priced', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'b/second', name: 'Second', pricing: { prompt: '0.000003', completion: '0.000004' } },
      { id: 'c/dynamic', name: 'Dynamic router', pricing: { prompt: '-1', completion: '-1' } },
    ],
  };

  let app: INestApplication;
  let prisma: PrismaService;
  let llm: LlmService;
  let fetchSpy: jest.SpyInstance;
  const tokens: Record<'admin' | 'cm' | 'user', string> = { admin: '', cm: '', user: '' };
  const stamp = Date.now();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const chatOk = (model: string, cost: number) =>
    json({
      model,
      provider: 'E2EProvider',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost },
    });

  const register = async (email: string): Promise<string> => {
    const res = await request(httpServerOf(app))
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  };

  const login = async (email: string): Promise<string> => {
    const res = await request(httpServerOf(app))
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const resetBudget = () =>
    prisma.llmBudget.update({
      where: { id: LLM_BUDGET_ID },
      data: { ceilingUsd: 100, reservedUsd: 0, spentUsd: 0, defaultRunLimitUsd: 10 },
    });

  const urlOf = (input: unknown): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  const sentModels = () =>
    fetchSpy.mock.calls
      .filter(([url]) => urlOf(url).endsWith('/chat/completions'))
      .map(
        ([, init]) => (JSON.parse((init as RequestInit).body as string) as { model: string }).model,
      );

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
    llm = app.get(LlmService);
    app.get(LlmStageRegistry).register({
      stage: STAGE,
      model: 'a/priced',
      fallbacks: [],
      temperature: null,
      maxTokens: 100,
      enabled: true,
    });

    const adminEmail = `llm-admin-${stamp}@test.com`;
    const cmEmail = `llm-cm-${stamp}@test.com`;
    await register(adminEmail);
    await register(cmEmail);
    tokens.user = await register(`llm-user-${stamp}@test.com`);
    await grantStaffRoles(app, adminEmail);
    await grantStaffRoles(app, cmEmail, [RoleName.content_manager]);
    // Роль - в токене после входа заново.
    tokens.admin = await login(adminEmail);
    tokens.cm = await login(cmEmail);
    await resetBudget();
  });

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = '';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((url) => {
      if (urlOf(url).endsWith('/models')) return Promise.resolve(json(MODELS));
      return Promise.reject(new Error(`unexpected fetch ${urlOf(url)}`));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.OPENROUTER_API_KEY = '';
  });

  afterAll(async () => {
    // Строку потолка не удалять: её создаёт миграция, код её не воссоздаёт (В4).
    await resetBudget();
    await prisma.llmStageSetting.deleteMany({ where: { stage: STAGE } });
    await app.close();
  });

  describe('access: admin only', () => {
    // Три элемента в каждой строке: при коротких строках `it.each` отдаёт третьим аргументом
    // колбэк `done`, и он уходит в `send`.
    const routes: Array<['get' | 'put', string, object]> = [
      ['get', '/admin/llm/status', {}],
      ['get', '/admin/llm/models', {}],
      ['get', '/admin/llm/stage-settings', {}],
      ['put', `/admin/llm/stage-settings/${STAGE}`, { model: 'a/priced' }],
      ['put', '/admin/llm/budget', { ceilingUsd: '100' }],
    ];

    it.each(routes)('%s %s: 401 without a token', async (method, path, body) => {
      await request(httpServerOf(app))[method](path).send(body).expect(401);
    });

    it.each(routes)('%s %s: 403 for a plain user', async (method, path, body) => {
      await request(httpServerOf(app))
        [method](path)
        .set('Authorization', `Bearer ${tokens.user}`)
        .send(body)
        .expect(403);
    });

    it.each(routes)('%s %s: 403 for content_manager', async (method, path, body) => {
      await request(httpServerOf(app))
        [method](path)
        .set('Authorization', `Bearer ${tokens.cm}`)
        .send(body)
        .expect(403);
    });

    it.each(routes)('%s %s: 200 for admin', async (method, path, body) => {
      await request(httpServerOf(app))
        [method](path)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send(body)
        .expect(200);
    });
  });

  it('without a key: status is DISABLED with the default ceiling, model calls are 503', async () => {
    const res = await request(httpServerOf(app))
      .get('/admin/llm/status')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    expect(res.body).toEqual({
      state: 'DISABLED',
      keyConfigured: false,
      budgetConfigured: true,
      ceilingUsd: '100.00000000',
      spentUsd: '0.00000000',
      reservedUsd: '0.00000000',
      defaultRunLimitUsd: '10.00000000',
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-');

    // С ключом ответ тоже его не содержит.
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    const enabled = await request(httpServerOf(app))
      .get('/admin/llm/status')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    expect(enabled.body).toMatchObject({ state: 'ENABLED', keyConfigured: true });
    expect(JSON.stringify(enabled.body)).not.toContain(FAKE_KEY);
    process.env.OPENROUTER_API_KEY = '';

    const disabled = {
      status: 503,
      response: expect.objectContaining({ code: 'LLM_DISABLED' }) as unknown,
    };
    await expect(llm.createOperation({ kind: 'compare' })).rejects.toMatchObject(disabled);
    await expect(
      llm.callStage('any-operation', STAGE, [{ role: 'user', content: 'x' }]),
    ).rejects.toMatchObject(disabled);
    expect(sentModels()).toEqual([]);
  });

  it('lists models with prices per million tokens; a dynamic price is null', async () => {
    const res = await request(httpServerOf(app))
      .get('/admin/llm/models')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    expect(res.body).toMatchObject({ pagination: { page: 1, totalPages: 1, total: items.length } });
    expect(items.find((m) => m.id === 'a/priced')).toMatchObject({
      inputPerMTokUsd: '1.00000000',
      outputPerMTokUsd: '2.00000000',
    });
    expect(items.find((m) => m.id === 'c/dynamic')).toMatchObject({
      inputPerMTokUsd: null,
      outputPerMTokUsd: null,
    });
  });

  describe('stage settings', () => {
    const put = (stage: string, body: object) =>
      request(httpServerOf(app))
        .put(`/admin/llm/stage-settings/${stage}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send(body);

    it('rejects a model outside the OpenRouter list', async () => {
      await put(STAGE, { model: 'x/not-listed' }).expect(400);
      await put(STAGE, { model: 'a/priced', fallbacks: ['x/not-listed'] }).expect(400);
    });

    it('rejects a model without a price unless maxPricePerMTok is set (Р24)', async () => {
      await put(STAGE, { model: 'c/dynamic' }).expect(400);
      const res = await put(STAGE, { model: 'c/dynamic', maxPricePerMTok: '5' }).expect(200);
      expect(res.body).toMatchObject({ model: 'c/dynamic', maxPricePerMTok: '5.00000000' });
    });

    it('rejects out-of-range settings through HTTP', async () => {
      await put(STAGE, { model: 'a/priced', maxTokens: 5_000_000 }).expect(400);
      await put(STAGE, { model: 'a/priced', maxTokens: '100' }).expect(200);
      await put(STAGE, { model: 'a/priced', temperature: 3 }).expect(400);
      await put(STAGE, { model: 'a/priced', enabled: 'yes' }).expect(400);
      const many = Array.from({ length: 11 }, (_, i) => `x/${i}`);
      await put(STAGE, { model: 'a/priced', fallbacks: many }).expect(400);
    });

    it('404 for an unknown stage', async () => {
      await put('no_such_stage', { model: 'a/priced' }).expect(404);
    });

    it('switches the model of the next call without a deploy (§7 п.7)', async () => {
      process.env.OPENROUTER_API_KEY = FAKE_KEY;
      fetchSpy.mockImplementation((url, init) => {
        if (urlOf(url).endsWith('/models')) return Promise.resolve(json(MODELS));
        const body = JSON.parse((init as RequestInit).body as string) as { model: string };
        return Promise.resolve(chatOk(body.model, 0.001));
      });
      const op = await llm.createOperation({ kind: 'compare' });

      await put(STAGE, { model: 'a/priced' }).expect(200);
      await llm.callStage(op.id, STAGE, [{ role: 'user', content: 'one' }]);
      const res = await put(STAGE, { model: 'b/second' }).expect(200);
      expect(res.body).toMatchObject({ source: 'override', model: 'b/second' });
      await llm.callStage(op.id, STAGE, [{ role: 'user', content: 'two' }]);

      expect(sentModels()).toEqual(['a/priced', 'b/second']);
    });
  });

  describe('budget', () => {
    const putBudget = (body: object) =>
      request(httpServerOf(app))
        .put('/admin/llm/budget')
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send(body);

    afterEach(() => resetBudget());

    it('validates amounts: negative and too precise are 400, above the ceiling is fine (В1)', async () => {
      await putBudget({ ceilingUsd: '-1' }).expect(400);
      await putBudget({ ceilingUsd: '1.123456789' }).expect(400);
      await putBudget({ ceilingUsd: '1000000' }).expect(400);
      // null - не «не передано»: 400, а не 500 на разборе суммы.
      await putBudget({ ceilingUsd: null }).expect(400);
      await putBudget({ defaultRunLimitUsd: null }).expect(400);
      // Число с восемью знаками не превращается в '1e-8'.
      const tiny = await putBudget({ defaultRunLimitUsd: 0.00000001 }).expect(200);
      expect(tiny.body).toMatchObject({ defaultRunLimitUsd: '0.00000001' });
      const res = await putBudget({ ceilingUsd: 5, defaultRunLimitUsd: '50' }).expect(200);
      expect(res.body).toMatchObject({
        ceilingUsd: '5.00000000',
        defaultRunLimitUsd: '50.00000000',
      });
    });

    it('ceilingUsd: 0 is accepted and the next call is refused by the ceiling (Р25)', async () => {
      process.env.OPENROUTER_API_KEY = FAKE_KEY;
      const op = await llm.createOperation({ kind: 'compare' });
      await putBudget({ ceilingUsd: 0 }).expect(200);

      const call = llm.callStage(op.id, STAGE, [{ role: 'user', content: 'x' }]);
      await expect(call).rejects.toBeInstanceOf(LlmBudgetExceededError);
      await expect(call).rejects.toMatchObject({ level: 'ceiling' });
      expect(sentModels()).toEqual([]);
    });

    it('operation cost equals the sum of its calls to the cent (§7 п.8)', async () => {
      process.env.OPENROUTER_API_KEY = FAKE_KEY;
      const costs = [0.00123456, 0.0201, 0.33333333];
      let n = 0;
      fetchSpy.mockImplementation((url) => {
        if (urlOf(url).endsWith('/models')) return Promise.resolve(json(MODELS));
        return Promise.resolve(chatOk('a/priced', costs[n++]));
      });
      await request(httpServerOf(app))
        .put(`/admin/llm/stage-settings/${STAGE}`)
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({ model: 'a/priced' })
        .expect(200);
      const op = await llm.createOperation({ kind: 'compare' });
      for (let i = 0; i < costs.length; i++) {
        await llm.callStage(op.id, STAGE, [{ role: 'user', content: `c${i}` }]);
      }

      const operation = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
      const calls = await prisma.llmCall.findMany({ where: { operationId: op.id } });
      const sum = calls.reduce((s, c) => s.add(c.costUsd ?? 0), new Prisma.Decimal(0));
      expect(operation.spentUsd.toFixed(8)).toBe(sum.toFixed(8));
      expect(operation.spentUsd.toFixed(8)).toBe('0.35466789');
      expect(operation.reservedUsd.isZero()).toBe(true);
      expect(operation.limitUsd.toFixed(2)).toBe('10.00');
    });
  });

  describe('reserve (Р4, Р21)', () => {
    let budget: LlmBudgetService;
    const createOp = (limitUsd: string) =>
      prisma.llmOperation.create({
        data: { kind: 'compare', limitUsd },
        select: { id: true },
      });
    const reserve = (operationId: string, estimate: string, attempt = 1) =>
      budget.reserve({
        operationId,
        stage: STAGE,
        requestedModel: 'a/priced',
        attempt,
        estimateUsd: new Prisma.Decimal(estimate),
      });

    beforeAll(() => {
      budget = app.get(LlmBudgetService);
    });
    afterEach(() => resetBudget());

    it('two parallel reserves with room for one: exactly one passes', async () => {
      const op = await createOp('1.5');
      const results = await Promise.allSettled([reserve(op.id, '1'), reserve(op.id, '1', 2)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ level: 'operation' });
      const row = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
      expect(row.reservedUsd.toFixed(8)).toBe('1.00000000');
      // Отказ по операции откатывает и резерв потолка, взятый в той же транзакции.
      const ceiling = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
      expect(ceiling.reservedUsd.toFixed(8)).toBe('1.00000000');
    });

    it('two operations racing for the ceiling room of one: exactly one passes', async () => {
      await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: '1.5' } });
      const [a, b] = [await createOp('5'), await createOp('5')];
      const results = await Promise.allSettled([reserve(a.id, '1'), reserve(b.id, '1')]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject({
        level: 'ceiling',
      });
      const ceiling = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
      expect(ceiling.reservedUsd.toFixed(8)).toBe('1.00000000');
    });

    it.each(['paused', 'cancelled', 'done', 'failed'] as const)(
      'a %s operation reserves nothing',
      async (status) => {
        const op = await createOp('5');
        await prisma.llmOperation.update({ where: { id: op.id }, data: { status } });

        await expect(reserve(op.id, '0.1')).rejects.toMatchObject({
          code: 'LLM_OPERATION_NOT_ACTIVE',
        });
        const ceiling = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
        expect(ceiling.reservedUsd.isZero()).toBe(true);
        expect(await prisma.llmCall.count({ where: { operationId: op.id } })).toBe(0);
      },
    );

    it('a tiny estimate is reserved rounded up, never as zero', async () => {
      const op = await createOp('5');
      const { callId } = await reserve(op.id, '0.000000001');
      const call = await prisma.llmCall.findUniqueOrThrow({ where: { id: callId } });
      expect(call.reservedUsd.toFixed(8)).toBe('0.00000001');
    });

    it('money already spent counts against the limit and the ceiling', async () => {
      const op = await createOp('1');
      const first = await reserve(op.id, '0.5');
      await budget.settle(first.callId, {
        costUsd: new Prisma.Decimal('0.9'),
        costEstimated: false,
        durationMs: 1,
      });
      await expect(reserve(op.id, '0.5', 2)).rejects.toMatchObject({ level: 'operation' });

      await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: '1.2' } });
      const other = await createOp('5');
      await expect(reserve(other.id, '0.5')).rejects.toMatchObject({ level: 'ceiling' });
    });

    it('an estimate exactly equal to the remaining room passes', async () => {
      await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: '1' } });
      const op = await createOp('1');
      await expect(reserve(op.id, '1')).resolves.toHaveProperty('callId');
    });

    it('the ceiling is checked before the operation limit', async () => {
      await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: '0.5' } });
      const op = await createOp('0.1');
      await expect(reserve(op.id, '1')).rejects.toMatchObject({ level: 'ceiling' });
      const ceiling = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
      expect(ceiling.reservedUsd.isZero()).toBe(true);
    });

    it('a zero ceiling refuses even a free call (Р25 stop switch)', async () => {
      await prisma.llmBudget.update({ where: { id: LLM_BUDGET_ID }, data: { ceilingUsd: 0 } });
      const op = await createOp('5');
      await expect(reserve(op.id, '0')).rejects.toMatchObject({ level: 'ceiling' });
    });

    it('the fact replaces the reserve to the cent; an error releases it', async () => {
      const op = await createOp('5');
      const first = await reserve(op.id, '0.5');
      const second = await reserve(op.id, '0.5', 2);
      await budget.settle(first.callId, {
        costUsd: new Prisma.Decimal('0.12345678'),
        costEstimated: false,
        durationMs: 10,
      });
      await budget.settle(second.callId, {
        costUsd: new Prisma.Decimal(0),
        costEstimated: false,
        durationMs: 10,
        errorClass: 'http_400',
      });

      const row = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
      expect(row.spentUsd.toFixed(8)).toBe('0.12345678');
      expect(row.reservedUsd.isZero()).toBe(true);
      const ceiling = await prisma.llmBudget.findUniqueOrThrow({ where: { id: LLM_BUDGET_ID } });
      expect(ceiling.spentUsd.toFixed(8)).toBe('0.12345678');
      expect(ceiling.reservedUsd.isZero()).toBe(true);
    });

    it('a fact arriving after the cleanup writes nothing (Р21, В5)', async () => {
      const op = await createOp('5');
      const { callId } = await reserve(op.id, '0.5');
      // Чистка уже закрыла вызов (её код - F05-1w): отметка снятия резерва стоит.
      await prisma.llmCall.update({
        where: { id: callId },
        data: { reserveReleasedAt: new Date() },
      });
      const before = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });

      const written = await budget.settle(callId, {
        costUsd: new Prisma.Decimal('0.3'),
        costEstimated: false,
        durationMs: 10,
      });

      expect(written).toBe(false);
      const after = await prisma.llmOperation.findUniqueOrThrow({ where: { id: op.id } });
      expect(after.spentUsd.toFixed(8)).toBe(before.spentUsd.toFixed(8));
      expect(after.reservedUsd.toFixed(8)).toBe(before.reservedUsd.toFixed(8));
      const call = await prisma.llmCall.findUniqueOrThrow({ where: { id: callId } });
      expect(call.costUsd).toBeNull();
    });
  });
});
