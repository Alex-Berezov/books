import { SourceFetcherService } from '../../source-fetch/source-fetcher.service';
import { NotFoundException } from '@nestjs/common';
import { ContentDraft, LlmOperation, LlmTask } from '@prisma/client';
import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { LlmService } from '../../llm/llm.service';
import type { LlmTaskService } from '../../llm-worker/llm-task.service';
import type { LlmTaskContext } from '../../llm-worker/llm-task.types';
import type { ContentDraftService } from '../content-draft/content-draft.service';
import { awaitDraftContext } from '../content-draft/draft-context-wait';
import type { DossierDemandService } from '../dossier/dossier-demand.service';
import { runQualityLoop } from '../draft-quality/quality-loop';
import {
  AnalysisItem,
  AnalysisStep,
  AnalysisWriteData,
  analysisDataJson,
  emptyAnalysisData,
  PendingStep,
} from './analysis-write.data';
import { analysisRegenGate } from './analysis-write.fields';
import type { AnalysisWriteFields } from './analysis-write.fields';
import { AnalysisWriteHandler, analysisWriteTaskInput, StepRecord } from './analysis-write.handler';
import { fitStepInput } from './analysis-write.steps';

jest.mock('../draft-quality/quality-loop', () => ({
  ...jest.requireActual<object>('../draft-quality/quality-loop'),
  runQualityLoop: jest.fn(),
}));
jest.mock('../content-draft/draft-context-wait', () => ({ awaitDraftContext: jest.fn() }));
jest.mock('./analysis-write.steps', () => ({
  ...jest.requireActual<object>('./analysis-write.steps'),
  fitStepInput: jest.fn(),
  stepLoopSpec: jest.fn(() => ({})),
}));

/**
 * Шаги хода анализа и перегенерация блока на подменённых базе, цикле качества и записи
 * (`F07-1a`, `F07-1b`): пауза и продолжение с оплаченного, ход отбросили посреди шага, отказы
 * входа, конец хода, отказ задачи; перегенерация - условия, исходы и снятие отметки.
 */

const OP = 'op1';
const task = (payload: Record<string, unknown> = { draftId: 'd1' }, operationId = OP) =>
  ({ id: 't1', operationId, payload }) as unknown as LlmTask;
const ctx = {
  callOptions: {},
  renewLease: jest.fn().mockResolvedValue(undefined),
} as unknown as LlmTaskContext;

const rowOf = (patch: Partial<ContentDraft> = {}): ContentDraft => ({
  id: 'd1',
  bookVersionId: 'v1',
  kind: 'analysis_write',
  status: 'building',
  language: 'en',
  operationId: OP,
  data: null,
  model: null,
  failedReason: null,
  dossierId: 'dos1',
  glossaryId: null,
  waitingFor: null,
  translationRunLanguageId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...patch,
});

const stepRow = (step: 1 | 2 | 3 | 4 | 5): AnalysisStep => ({
  step,
  verdict: 'ok',
  remarks: [],
  attempt: 1,
  outcome: 'done',
  failedReason: null,
  authorModel: 'm',
  review: { kind: 'answered', model: 'r' },
  source: 'text',
  dropped: [],
});

const item = (patch: Partial<AnalysisItem> = {}): AnalysisItem => ({
  target: 'characters',
  step: 1,
  verdict: 'ok',
  remarks: [],
  review: null,
  outcome: 'proposed',
  hash: 'h',
  value: [{ key: 'anna' }],
  failedReason: null,
  links: false,
  regen: null,
  regenFailedReason: null,
  ...patch,
});

const dataOf = (patch: Partial<AnalysisWriteData> = {}): AnalysisWriteData => ({
  ...emptyAnalysisData({}, {}),
  ...patch,
});

const LOOP_OK = {
  ok: true,
  draft: {
    blocks: { characters: [{ key: 'anna' }] },
    themeLinks: null,
    droppedQuotes: [],
    fixes: [],
  },
  remarks: [],
  verdict: 'ok',
  attempt: 1,
  authorModel: 'z-ai/glm-5.3',
  review: { kind: 'answered', model: 'openai/gpt-6-luna' },
};

function setup(row: ContentDraft | null = rowOf()) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    contentDraft: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const prisma = {
    contentDraft: { findUnique: jest.fn().mockResolvedValue(row) },
    bookDossier: { findUnique: jest.fn().mockResolvedValue({ id: 'dos1', data: {} }) },
    llmOperation: { findUnique: jest.fn().mockResolvedValue({ settingsSnapshot: null }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const run = (fn?: (t: typeof tx) => Promise<void>) =>
    (fn ? fn(tx) : Promise.resolve()).then(() => true);
  const tasks = {
    completeOperation: jest.fn((_id: string, fn?: (t: typeof tx) => Promise<void>) => run(fn)),
    failOperation: jest.fn((_id: string, fn?: (t: typeof tx) => Promise<void>) => run(fn)),
    pauseOperation: jest.fn().mockResolvedValue(true),
  };
  const fields = {
    read: jest.fn(),
    settleStep: jest.fn().mockResolvedValue('settled'),
    mutate: jest.fn(),
    markCore: jest.fn().mockResolvedValue(true),
  };
  const handler = new AnalysisWriteHandler(
    prisma as unknown as PrismaService,
    { stageFit: jest.fn() } as unknown as LlmService,
    tasks as unknown as LlmTaskService,
    {} as DossierDemandService,
    { languageOf: jest.fn() } as unknown as ContentDraftService,
    fields as unknown as AnalysisWriteFields,
    { fetchMany: jest.fn().mockResolvedValue([]) } as unknown as SourceFetcherService,
  );
  jest
    .spyOn(handler, 'contextOf')
    .mockResolvedValue({ chapters: [], stored: EMPTY_BOOK_ANALYSIS } as never);
  return { handler, prisma, tx, tasks, fields };
}

/** Запись `mutate`: правка данных ходом `make()`, как под замком настоящей записи. */
const savedBy =
  (make: () => AnalysisWriteData | null) =>
  (_row: unknown, _gate: unknown, fn: (d: AnalysisWriteData) => AnalysisWriteData | null) =>
    Promise.resolve({ data: fn(make() ?? dataOf()), written: true });

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mocked(fitStepInput).mockResolvedValue({ input: {}, source: 'text' });
  mocked(runQualityLoop).mockResolvedValue(LOOP_OK);
});

describe('AnalysisWriteHandler: a step of the run (F07-1a)', () => {
  it('the run was discarded, ended or belongs to another operation: the step ends, the operation is closed, nothing is read', async () => {
    for (const row of [
      rowOf({ status: 'discarded' }),
      rowOf({ operationId: 'other' }),
      rowOf({ kind: 'summary_write' }),
      null,
    ]) {
      const { handler, tasks, fields } = setup(row);
      await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'done' });
      expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
      expect(tasks.completeOperation).toHaveBeenCalledWith(OP);
      expect(fields.read).not.toHaveBeenCalled();
    }
  });

  it('no dossier yet: the run waits for the dossier and glossary, no model is called', async () => {
    const { handler } = setup(rowOf({ dossierId: null }));
    mocked(awaitDraftContext).mockResolvedValue({ kind: 'continue' });
    await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'continue' });
    expect(awaitDraftContext).toHaveBeenCalledTimes(1);
    expect(runQualityLoop).not.toHaveBeenCalled();
  });

  it('the dossier is gone: the run fails DRAFT_INPUT_MISSING with the operation in one write', async () => {
    const { handler, prisma, tasks, tx } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(null);
    await handler.handler.run(task(), ctx);
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).toHaveBeenCalledWith(OP, expect.any(Function));
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_INPUT_MISSING' },
    });
  });

  it('the version was deleted mid-step (404 of the analysis service): DRAFT_INPUT_MISSING, not a crash', async () => {
    const { handler, fields, tx } = setup();
    fields.read.mockRejectedValue(new NotFoundException());
    await handler.handler.run(task(), ctx);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_INPUT_MISSING' } }),
    );
  });

  it('a step record of the wrong shape: DRAFT_DATA_INVALID, the paid step is not repeated', async () => {
    const { handler, fields, tx } = setup();
    fields.read.mockResolvedValue(dataOf({ stepsBroken: true }));
    await handler.handler.run(task(), ctx);
    expect(runQualityLoop).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_DATA_INVALID' } }),
    );
  });

  it('a step result saved but not decided (a break between the writes): decided once per step before the next step; gone ends the step', async () => {
    const { handler, fields, tasks } = setup();
    fields.read.mockResolvedValue(
      dataOf({
        steps: [stepRow(1), stepRow(2)],
        items: [
          item({ outcome: 'waiting', step: 1 }),
          item({ outcome: 'waiting', step: 1, target: 'style' }),
          item({ outcome: 'waiting', step: 2, target: 'keyQuotes' }),
        ],
      }),
    );
    fields.mutate.mockResolvedValue({ data: dataOf(), written: true });
    await handler.handler.run(task(), ctx);
    expect(
      (fields.settleStep.mock.calls as Array<[unknown, unknown, number]>).map(([, , step]) => step),
    ).toEqual([1, 2, 3]);
    fields.settleStep.mockReset().mockResolvedValue('gone');
    await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith(OP);
  });

  it('the paid text of the step is kept until the result: the loop resumes from it; a text of another step or operation is not resumed', async () => {
    const resume = {
      draft: { blocks: {}, themeLinks: null, droppedQuotes: [], fixes: [] },
      attempt: 1 as const,
      authorModel: 'z-ai/glm-5.3',
    };
    const pending = (key: string, operationId = OP): PendingStep => ({ key, operationId, resume });
    const { handler, fields } = setup();
    fields.mutate.mockResolvedValue({ data: dataOf(), written: true });
    fields.read.mockResolvedValue(dataOf({ pending: pending('step:1') }));
    await handler.handler.run(task(), ctx);
    expect(mocked(runQualityLoop).mock.calls[0][3]).toMatchObject({ resume });
    mocked(runQualityLoop).mockClear();
    fields.read.mockResolvedValue(dataOf({ pending: pending('step:2') }));
    await handler.handler.run(task(), ctx);
    expect(mocked(runQualityLoop).mock.calls[0][3].resume).toBeUndefined();
    mocked(runQualityLoop).mockClear();
    fields.read.mockResolvedValue(dataOf({ pending: pending('step:1', 'op-old') }));
    await handler.handler.run(task(), ctx);
    expect(mocked(runQualityLoop).mock.calls[0][3].resume).toBeUndefined();
  });

  it('the run was discarded while the author was paid: the saving of the text says so (gone) and the step ends without a write', async () => {
    const { handler, fields, tasks } = setup();
    fields.read.mockResolvedValue(dataOf());
    fields.mutate.mockResolvedValue(null);
    // Цикл качества после сохранения оплаченного текста идёт дальше (проверяющая, переделка): ход,
    // которого уже нет, его прервать должен, а не оплатить следующий вызов.
    let paidAfterGone = false;
    mocked(runQualityLoop).mockImplementation(
      async (
        _llm: unknown,
        _op: unknown,
        _ctx: unknown,
        spec: { onAuthored: (a: unknown) => Promise<void> },
      ) => {
        await spec.onAuthored({ draft: LOOP_OK.draft, attempt: 1, authorModel: 'm' });
        paidAfterGone = true;
        return LOOP_OK;
      },
    );
    await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'done' });
    expect(paidAfterGone).toBe(false);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith(OP);
    expect(fields.settleStep).not.toHaveBeenCalled();
  });

  it('the input does not fit even as chapter summaries: the step is recorded as failed DRAFT_TOO_LONG, the run goes on', async () => {
    const { handler, fields } = setup();
    fields.read.mockResolvedValue(dataOf());
    mocked(fitStepInput).mockResolvedValue(null);
    fields.mutate.mockImplementation(savedBy(() => dataOf()));
    await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'continue' });
    const written = (await fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(written.data.steps).toMatchObject([
      { step: 1, outcome: 'failed', failedReason: 'DRAFT_TOO_LONG', verdict: 'failed' },
    ]);
    expect(runQualityLoop).not.toHaveBeenCalled();
  });

  it('the loop gave no answer: the step is failed DRAFT_INVALID_RESPONSE', async () => {
    const { handler, fields } = setup();
    fields.read.mockResolvedValue(dataOf());
    mocked(runQualityLoop).mockResolvedValue({ ok: false });
    fields.mutate.mockImplementation(savedBy(() => dataOf()));
    await handler.handler.run(task(), ctx);
    const written = (await fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(written.data.steps[0]).toMatchObject({
      outcome: 'failed',
      failedReason: 'DRAFT_INVALID_RESPONSE',
    });
  });

  it('the step was written by another attempt (lease lost mid-call): this result is not decided, the run continues from the written', async () => {
    const { handler, fields } = setup();
    fields.read.mockResolvedValue(dataOf());
    fields.mutate.mockResolvedValue({ data: dataOf(), written: false });
    await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'continue' });
    expect(fields.settleStep).not.toHaveBeenCalled();
  });

  it('a run of F07-1 (three steps) is ready after step 3; a run of five steps is ready after step 5, not before', async () => {
    const legacy = setup();
    legacy.fields.read.mockResolvedValue(
      dataOf({ steps: [stepRow(1), stepRow(2), stepRow(3)], stepsTotal: 3 }),
    );
    await legacy.handler.handler.run(task(), ctx);
    expect(legacy.fields.markCore).toHaveBeenCalledTimes(1);
    const five = setup();
    five.fields.read.mockResolvedValue(
      dataOf({ steps: [1, 2, 3, 4, 5].map((n) => stepRow(n as 1 | 2 | 3 | 4 | 5)), stepsTotal: 5 }),
    );
    await five.handler.handler.run(task(), ctx);
    expect(five.fields.markCore).toHaveBeenCalledTimes(1);
    expect(five.tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
  });

  it('after step 3 the core is marked and the run is ready together with its operation; a run that stopped taking writes is only closed', async () => {
    const { handler, fields, tasks, tx } = setup();
    fields.read.mockResolvedValue(
      dataOf({ steps: [stepRow(1), stepRow(2), stepRow(3)], stepsTotal: 3 }),
    );
    await expect(handler.handler.run(task(), ctx)).resolves.toEqual({ kind: 'done' });
    expect(fields.markCore).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith(OP, expect.any(Function));
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building', operationId: OP },
      data: { status: 'ready', waitingFor: null },
    });
    tasks.completeOperation.mockClear();
    fields.markCore.mockResolvedValue(null);
    await handler.handler.run(task(), ctx);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith(OP);
  });

  it('money and provider refusals pause the operation with their reason, others - STEP_FAILED', async () => {
    const { handler, tasks } = setup();
    await handler.handler.onFailed?.(task(), 'LLM_BUDGET_EXCEEDED:ceiling');
    await handler.handler.onFailed?.(task(), 'LLM_PROVIDER_ERROR');
    expect(tasks.pauseOperation.mock.calls).toEqual([
      [OP, 'CEILING_REACHED'],
      [OP, 'STEP_FAILED'],
    ]);
  });
});

describe('analysisWriteTaskInput', () => {
  it('the task of the run carries the draft; the task of a regeneration - the index of the block too', () => {
    const row = { id: 'd1', bookVersionId: 'v1', language: 'en' as const };
    expect(analysisWriteTaskInput(row, 'op1')).toMatchObject({
      kind: 'analysis_write',
      payload: { draftId: 'd1' },
      pairKey: 'op1:d1',
    });
    expect(analysisWriteTaskInput(row, 'op2', 3)).toMatchObject({
      payload: { draftId: 'd1', index: 3 },
      pairKey: 'op2:d1:3',
    });
  });
});

describe('AnalysisWriteHandler: regeneration of a block (F07-1b)', () => {
  const REGEN_OP = 'op2';
  const regen = { operationId: REGEN_OP, remark: 'shorter', pending: null, previous: null };
  const ready = rowOf({ status: 'ready' });
  const regenTask = task({ draftId: 'd1', index: 0 }, REGEN_OP);
  const record = (patch: Partial<StepRecord> = {}): StepRecord => ({
    step: { ...stepRow(1), remarks: [] },
    draft: {
      blocks: { characters: [{ key: 'anna', name: 'New' }] } as never,
      themeLinks: null,
      droppedQuotes: [],
      fixes: [],
    },
    invalid: new Set(),
    review: { kind: 'answered', model: 'r' },
    ...patch,
  });

  function regenSetup(items: AnalysisItem[]) {
    const s = setup(ready);
    s.fields.read.mockResolvedValue(dataOf({ items }));
    const produce = jest
      .spyOn(
        s.handler as unknown as { produceStep: () => Promise<StepRecord | null> },
        'produceStep',
      )
      .mockResolvedValue(record());
    return { ...s, produce };
  }

  it('the mark is gone (cancelled, discarded run): nothing is paid, the operation is closed through the clearing of the mark', async () => {
    const s = setup(ready);
    s.fields.read.mockResolvedValue(null);
    await expect(s.handler.handler.run(regenTask, ctx)).resolves.toEqual({ kind: 'done' });
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(s.tasks.completeOperation).toHaveBeenCalledWith(REGEN_OP, expect.any(Function));
    expect(runQualityLoop).not.toHaveBeenCalled();
    expect(s.fields.read).toHaveBeenCalledTimes(1);
    expect(s.fields.read).toHaveBeenCalledWith(ready, expect.objectContaining({ status: 'ready' }));
  });

  it('a row of another kind under a regeneration task: only the operation is closed', async () => {
    const s = setup(rowOf({ kind: 'summary_write', status: 'ready' }));
    await s.handler.handler.run(regenTask, ctx);
    expect(s.fields.read).not.toHaveBeenCalled();
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
  });

  it('the model is called under the operation of the regeneration (its budget, its snapshot of models), not under the operation of the run', async () => {
    const s = setup(ready);
    s.fields.read.mockResolvedValue(dataOf({ items: [item({ regen })] }));
    s.fields.mutate.mockImplementation(savedBy(() => dataOf({ items: [item({ regen })] })));
    await s.handler.handler.run(regenTask, ctx);
    expect(mocked(runQualityLoop).mock.calls[0][1]).toBe(REGEN_OP);
    expect(s.prisma.llmOperation.findUnique).toHaveBeenCalledTimes(1);
    expect(s.prisma.llmOperation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REGEN_OP } }),
    );
    // Оплаченный текст перегенерации лежит в её блоке и помечен её операцией.
    mocked(runQualityLoop).mockImplementationOnce(
      async (
        _llm: unknown,
        _op: unknown,
        _ctx: unknown,
        spec: { onAuthored: (a: unknown) => Promise<void> },
      ) => {
        await spec.onAuthored({ draft: LOOP_OK.draft, attempt: 1, authorModel: 'm' });
        return LOOP_OK;
      },
    );
    s.fields.mutate.mockClear();
    await s.handler.handler.run(regenTask, ctx);
    const kept = s.fields.mutate.mock.calls[0][2] as (d: AnalysisWriteData) => AnalysisWriteData;
    expect(kept(dataOf({ items: [item({ regen })] })).items[0].regen?.pending).toMatchObject({
      key: 'regen:0',
      operationId: REGEN_OP,
    });
  });

  it('a paid result that was not decided (waiting): decided without a second call of the model, then the mark is cleared', async () => {
    const s = regenSetup([item({ outcome: 'waiting', regen })]);
    await s.handler.handler.run(regenTask, ctx);
    expect(s.fields.settleStep).toHaveBeenCalledTimes(1);
    expect(s.fields.settleStep).toHaveBeenCalledWith(ready, expect.anything(), 1, 0);
    expect(s.produce).not.toHaveBeenCalled();
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(s.tasks.completeOperation).toHaveBeenCalledWith(REGEN_OP, expect.any(Function));
  });

  it('the result is saved as waiting and decided for this block alone (the index goes to the decision), then the mark is cleared', async () => {
    const s = regenSetup([item({ regen })]);
    s.fields.mutate.mockImplementation(savedBy(() => dataOf({ items: [item({ regen })] })));
    await s.handler.handler.run(regenTask, ctx);
    const saved = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(saved.data.items[0]).toMatchObject({
      outcome: 'waiting',
      value: [{ key: 'anna', name: 'New' }],
      regenFailedReason: null,
    });
    expect(s.fields.settleStep).toHaveBeenCalledTimes(1);
    expect(s.fields.settleStep).toHaveBeenCalledWith(ready, expect.anything(), 1, 0);
    expect(s.produce).toHaveBeenCalledTimes(1);
    expect(s.produce).toHaveBeenCalledWith(
      ready,
      expect.anything(),
      1,
      expect.anything(),
      null,
      ctx,
      { spec: { target: 'characters', current: [{ key: 'anna' }], remark: 'shorter' }, index: 0 },
    );
  });

  it.each([
    [
      'the step failed',
      record({ step: { ...stepRow(1), outcome: 'failed', failedReason: 'DRAFT_TOO_LONG' } }),
      'DRAFT_TOO_LONG',
    ],
    [
      'the block did not pass the import after the redo',
      record({
        draft: { blocks: {}, themeLinks: null, droppedQuotes: [], fixes: [] },
        invalid: new Set(['characters']),
      }),
      'IMPORT_INVALID',
    ],
    [
      'the answer has no such block',
      record({ draft: { blocks: {}, themeLinks: null, droppedQuotes: [], fixes: [] } }),
      'DRAFT_INVALID_RESPONSE',
    ],
    [
      'the check of the sources dropped every statement of the block (F07-2b)',
      record({
        draft: { blocks: {}, themeLinks: null, droppedQuotes: [], fixes: [] },
        unverified: new Set(['characters']),
      }),
      'EXTERNAL_UNVERIFIED',
    ],
  ])(
    '%s: the block stays, the reason is kept in regenFailedReason, nothing is decided',
    async (_name, outcome, reason) => {
      const s = regenSetup([item({ regen })]);
      s.produce.mockResolvedValue(outcome);
      s.fields.mutate.mockImplementation(savedBy(() => dataOf({ items: [item({ regen })] })));
      await s.handler.handler.run(regenTask, ctx);
      // Шаг упал целиком - записывать нечего; иначе пишутся только причины снятия (F07-2b, Q2):
      // блок тот же, итога нет.
      if (outcome.step.outcome !== 'failed') {
        expect(s.fields.mutate).toHaveBeenCalledTimes(1);
        const kept = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
        expect(kept.data.items[0]).toEqual(item({ regen }));
      } else {
        expect(s.fields.mutate).not.toHaveBeenCalled();
      }
      expect(s.fields.settleStep).not.toHaveBeenCalled();
      // Причина уходит в снятие отметки той же транзакцией, что закрывает операцию.
      const clear = s.tasks.completeOperation.mock.calls[0][1] as (t: typeof s.tx) => Promise<void>;
      s.tx.$queryRaw.mockResolvedValue([{ id: 'd1', bookVersionId: 'v1' }]);
      s.tx.contentDraft.findUnique.mockResolvedValue({
        ...ready,
        data: analysisDataJson(dataOf({ items: [item({ regen })] })),
      });
      await clear(s.tx);
      const written = s.tx.contentDraft.update.mock.calls[0][0] as {
        data: { data: { items: AnalysisItem[] } };
      };
      expect(written.data.data.items[0]).toMatchObject({ regen: null, regenFailedReason: reason });
    },
  );

  it('the run is gone while paying (the saving of the text found no mark): the operation is closed, no decision', async () => {
    const s = regenSetup([item({ regen })]);
    s.produce.mockResolvedValue(null);
    await s.handler.handler.run(regenTask, ctx);
    expect(s.fields.settleStep).not.toHaveBeenCalled();
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(s.tasks.completeOperation).toHaveBeenCalledWith(REGEN_OP, expect.any(Function));
  });

  it('the dossier of the run is gone: DRAFT_INPUT_MISSING in regenFailedReason', async () => {
    const s = regenSetup([item({ regen })]);
    s.prisma.bookDossier.findUnique.mockResolvedValue(null);
    await s.handler.handler.run(regenTask, ctx);
    expect(s.produce).not.toHaveBeenCalled();
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
  });

  it('regenResume finds the block by the mark of the operation and enqueues its task with the index; no row - nothing', async () => {
    const s = setup(ready);
    s.prisma.$queryRaw.mockResolvedValue([{ id: 'd1' }]);
    s.prisma.contentDraft.findUnique.mockResolvedValue({
      ...ready,
      data: analysisDataJson(dataOf({ items: [item(), item({ regen })] })),
    });
    await expect(s.handler.regenResume({ id: REGEN_OP } as LlmOperation)).resolves.toEqual([
      expect.objectContaining({ operationId: REGEN_OP, payload: { draftId: 'd1', index: 1 } }),
    ]);
    s.prisma.$queryRaw.mockResolvedValue([]);
    await expect(s.handler.regenResume({ id: REGEN_OP } as LlmOperation)).resolves.toEqual([]);
  });

  it('cancel of the regeneration clears the mark of its block, the run stays ready; no such mark - nothing is written', async () => {
    const s = setup(ready);
    s.tx.$queryRaw.mockResolvedValueOnce([{ id: 'd1', bookVersionId: 'v1' }]);
    s.tx.contentDraft.findUnique.mockResolvedValue({
      ...ready,
      data: analysisDataJson(dataOf({ items: [item(), item({ regen })] })),
    });
    await s.handler.onRegenCancelled({ id: REGEN_OP } as LlmOperation, s.tx as never);
    const written = s.tx.contentDraft.update.mock.calls[0][0] as {
      data: { data: { items: AnalysisItem[] } };
    };
    expect(written.data.data.items.map((i) => i.regen)).toEqual([null, null]);
    s.tx.contentDraft.update.mockClear();
    s.tx.$queryRaw.mockResolvedValue([]);
    await s.handler.onRegenCancelled({ id: REGEN_OP } as LlmOperation, s.tx as never);
    expect(s.tx.contentDraft.update).not.toHaveBeenCalled();
  });
});

describe('the gate of a regeneration', () => {
  it('the gate of a regeneration reads the block of its own operation only', () => {
    const gate = analysisRegenGate('op2', 0);
    const row = rowOf({ status: 'ready' });
    expect(
      gate.allows(
        row,
        dataOf({
          items: [
            item({ regen: { operationId: 'op2', remark: null, pending: null, previous: null } }),
          ],
        }),
      ),
    ).toBe(true);
    expect(gate.allows(row, dataOf({ items: [item()] }))).toBe(false);
    expect(gate.allows(rowOf({ status: 'building' }), dataOf())).toBe(false);
  });
});

describe('AnalysisWriteHandler: F07-2b', () => {
  const REGEN_OP = 'op2';
  const ready = rowOf({ status: 'ready' });
  const regenTask = task({ draftId: 'd1', index: 0 }, REGEN_OP);

  it('the result of a regeneration is already decided but the operation is open (a break before its end) - only closed, nothing is paid again', async () => {
    const s = setup(ready);
    const previous = item();
    const regen = { operationId: REGEN_OP, remark: null, pending: null, previous };
    s.fields.read.mockResolvedValue(dataOf({ items: [item({ outcome: 'proposed', regen })] }));
    const produce = jest.spyOn(
      s.handler as unknown as { produceStep: () => Promise<StepRecord | null> },
      'produceStep',
    );
    await expect(s.handler.handler.run(regenTask, ctx)).resolves.toEqual({ kind: 'done' });
    expect(produce).not.toHaveBeenCalled();
    expect(runQualityLoop).not.toHaveBeenCalled();
    expect(s.fields.settleStep).not.toHaveBeenCalled();
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(s.tasks.completeOperation).toHaveBeenCalledWith(REGEN_OP, expect.any(Function));
  });

  it('no source opened by the channel - the task fails, the operation pauses STEP_FAILED, «Continue» resumes the paid text without a second call of the author', async () => {
    const s = setup();
    const fetcher = (s.handler as unknown as { fetcher: { fetchMany: jest.Mock } }).fetcher;
    fetcher.fetchMany.mockResolvedValue([
      { ok: false, reason: 'NETWORK', host: 'a.example', url: 'https://a.example/1' },
    ]);
    const external = {
      ...LOOP_OK,
      draft: {
        blocks: {
          context: 'Paragraph.',
          sources: [{ title: 'A', url: 'https://a.example/1' }],
        },
        themeLinks: null,
        refs: { facts: {}, context: [[0]], reception: [], timeline: [], adaptations: [] },
        droppedQuotes: [],
        fixes: [],
      },
    };
    mocked(runQualityLoop).mockResolvedValue(external);
    const steps = [stepRow(1), stepRow(2), stepRow(3), stepRow(4)];
    s.fields.read.mockResolvedValue(dataOf({ steps, stepsTotal: 5 }));
    await expect(s.handler.handler.run(task(), ctx)).rejects.toThrow(/network of the worker/);
    // Повтор задачи - тоже один раз: адрес не больше двух запросов за проход.
    expect(fetcher.fetchMany).toHaveBeenCalledTimes(2);
    expect(s.fields.mutate).not.toHaveBeenCalled();
    await s.handler.handler.onFailed?.(task(), 'No source of the external step could be reached');
    expect(s.tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(s.tasks.pauseOperation).toHaveBeenCalledWith(OP, 'STEP_FAILED');
    // «Continue»: оплаченный текст шага 5 лежит в данных хода - цикл получает его, автор не зовётся.
    const resume = { draft: external.draft, attempt: 1, authorModel: 'm' };
    s.fields.read.mockResolvedValue(
      dataOf({
        steps,
        stepsTotal: 5,
        pending: { key: 'step:5', operationId: OP, resume } as never,
      }),
    );
    // Сеть всё ещё лежит: шаг снова не решается - и снова без записи.
    await expect(s.handler.handler.run(task(), ctx)).rejects.toThrow(/network of the worker/);
    expect(s.fields.mutate).not.toHaveBeenCalled();
    // Цикл получил оплаченный текст: с `resume` первого прохода автор не зовётся - это держит
    // `quality-loop.spec.ts` («resume after a break»).
    expect(runQualityLoop).toHaveBeenCalledTimes(2);
    const spec = mocked(runQualityLoop).mock.calls[1][3] as { resume?: unknown };
    expect(spec.resume).toBe(resume);
  });

  it('a regeneration of a step 5 block with no source opened by the channel: the task fails, the mark stays, the paid text is resumed from the block', async () => {
    const s = setup(ready);
    const fetcher = (s.handler as unknown as { fetcher: { fetchMany: jest.Mock } }).fetcher;
    fetcher.fetchMany.mockResolvedValue([
      { ok: false, reason: 'NETWORK', host: 'a.example', url: 'https://a.example/1' },
    ]);
    mocked(runQualityLoop).mockResolvedValue({
      ...LOOP_OK,
      draft: {
        blocks: { context: 'Paragraph.', sources: [{ title: 'A', url: 'https://a.example/1' }] },
        themeLinks: null,
        refs: { facts: {}, context: [[0]], reception: [], timeline: [], adaptations: [] },
        droppedQuotes: [],
        fixes: [],
      },
    });
    const resume = { draft: LOOP_OK.draft, attempt: 1, authorModel: 'm' };
    const regen = {
      operationId: REGEN_OP,
      remark: null,
      pending: { key: 'regen:0', operationId: REGEN_OP, resume } as never,
      previous: null,
    };
    s.fields.read.mockResolvedValue(
      dataOf({ items: [item({ target: 'context', step: 5, regen })] }),
    );
    await expect(s.handler.handler.run(regenTask, ctx)).rejects.toThrow(/network of the worker/);
    // Отметка не снята и операция не закрыта: «Continue» повторит перегенерацию.
    expect(s.tasks.completeOperation).not.toHaveBeenCalled();
    expect(s.fields.mutate).not.toHaveBeenCalled();
    expect(runQualityLoop).toHaveBeenCalledTimes(1);
    expect((mocked(runQualityLoop).mock.calls[0][3] as { resume?: unknown }).resume).toBe(resume);
  });

  it('the paths of the other remarks of step 5 follow the kept elements after the check of the sources', async () => {
    const s = setup();
    jest.spyOn(s.handler, 'contextOf').mockResolvedValue({
      chapters: [],
      stored: EMPTY_BOOK_ANALYSIS,
      bookTitle: 'Book',
      author: 'Ann Author',
    } as never);
    const fetcher = (s.handler as unknown as { fetcher: { fetchMany: jest.Mock } }).fetcher;
    fetcher.fetchMany.mockResolvedValue([
      {
        ok: false,
        reason: 'HTTP_STATUS',
        status: 404,
        host: 'a.example',
        url: 'https://a.example/1',
      },
      { ok: true, text: 'Book by Ann Author', host: 'b.example', url: 'https://b.example/2' },
    ]);
    mocked(runQualityLoop).mockResolvedValue({
      ...LOOP_OK,
      verdict: 'flags',
      remarks: [{ code: 'STYLE_POOR', where: 'timeline.1', note: 'n', by: 'review' }],
      draft: {
        blocks: {
          timeline: [
            { year: 1860, event: 'A', kind: 'book' },
            { year: 1866, event: 'B', kind: 'book' },
          ],
          sources: [
            { title: 'A', url: 'https://a.example/1' },
            { title: 'B', url: 'https://b.example/2' },
          ],
        },
        themeLinks: null,
        refs: { facts: {}, context: [], reception: [], timeline: [[0], [1]], adaptations: [] },
        droppedQuotes: [],
        fixes: [],
      },
    } as never);
    const steps = [stepRow(1), stepRow(2), stepRow(3), stepRow(4)];
    s.fields.read.mockResolvedValue(dataOf({ steps, stepsTotal: 5 }));
    s.fields.mutate.mockImplementation(savedBy(() => dataOf({ steps, stepsTotal: 5 })));
    await s.handler.handler.run(task(), ctx);
    const saved = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    const step5 = saved.data.steps.find((x) => x.step === 5);
    // Элемент 0 снят вместе с источником: замечание элемента 1 теперь на `timeline.0`.
    expect(step5?.remarks.filter((r) => r.code === 'STYLE_POOR').map((r) => r.where)).toEqual([
      'timeline.0',
    ]);
  });
});

describe('AnalysisWriteHandler: the limit of the saved sources at a regeneration (F07-2b, /fix 2)', () => {
  const REGEN_OP = 'op2';
  const ready = rowOf({ status: 'ready' });
  const regenTask = task({ draftId: 'd1', index: 0 }, REGEN_OP);
  const src = (n: number) => ({ title: `S${n}`, url: `https://s${n}.example/page` });

  function run(saved: Array<{ title: string; url: string }>) {
    const s = setup(ready);
    jest.spyOn(s.handler, 'contextOf').mockResolvedValue({
      chapters: [],
      stored: { ...EMPTY_BOOK_ANALYSIS, sources: saved },
      bookTitle: 'Book',
      author: 'Ann Author',
    } as never);
    const fetcher = (s.handler as unknown as { fetcher: { fetchMany: jest.Mock } }).fetcher;
    fetcher.fetchMany.mockResolvedValue([
      { ok: true, text: 'Book by Ann Author', host: 's1.example', url: src(1).url },
    ]);
    mocked(runQualityLoop).mockResolvedValue({
      ...LOOP_OK,
      draft: {
        blocks: { context: 'Paragraph.', sources: [src(1)] },
        themeLinks: null,
        refs: { facts: {}, context: [[0]], reception: [], timeline: [], adaptations: [] },
        droppedQuotes: [],
        fixes: [],
      },
    } as never);
    const regen = { operationId: REGEN_OP, remark: null, pending: null, previous: null };
    const data = () =>
      dataOf({
        steps: [stepRow(1), stepRow(2), stepRow(3), stepRow(4), stepRow(5)],
        items: [item({ target: 'context', step: 5, regen })],
      });
    s.fields.read.mockResolvedValue(data());
    s.fields.mutate.mockImplementation(savedBy(data));
    return s;
  }

  it('room in the saved sources: the new source is kept with the result', async () => {
    const saved = [src(100)];
    const s = run(saved);
    await s.handler.handler.run(regenTask, ctx);
    const result = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(result.data.items[0]).toMatchObject({
      outcome: 'waiting',
      value: 'Paragraph.',
      pendingSources: [src(1)],
    });
  });

  it('the saved sources are full: the new source does not fit, the block stays, the reason is the limit and it is recorded', async () => {
    const saved = Array.from({ length: 15 }, (_, i) => src(100 + i));
    const s = run(saved);
    await s.handler.handler.run(regenTask, ctx);
    expect(s.fields.mutate).toHaveBeenCalledTimes(1);
    const kept = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(kept.data.items[0]).toEqual(
      item({
        target: 'context',
        step: 5,
        regen: { operationId: REGEN_OP, remark: null, pending: null, previous: null },
      }),
    );
    expect(kept.data.steps.find((x) => x.step === 5)?.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LIMIT_OUT', path: 'sources.0' }),
        expect.objectContaining({ code: 'LIMIT_OUT', path: 'context.0' }),
      ]),
    );
    expect(s.fields.settleStep).not.toHaveBeenCalled();
    // Причина - предел, а не «не подтвердилось»: место освобождают, а не перегенерируют.
    const clear = s.tasks.completeOperation.mock.calls[0][1] as (t: typeof s.tx) => Promise<void>;
    s.tx.$queryRaw.mockResolvedValue([{ id: 'd1', bookVersionId: 'v1' }]);
    s.tx.contentDraft.findUnique.mockResolvedValue({
      ...ready,
      data: analysisDataJson(
        dataOf({
          items: [
            item({
              target: 'context',
              step: 5,
              regen: { operationId: REGEN_OP, remark: null, pending: null, previous: null },
            }),
          ],
        }),
      ),
    });
    await clear(s.tx);
    const written = s.tx.contentDraft.update.mock.calls[0][0] as {
      data: { data: { items: AnalysisItem[] } };
    };
    expect(written.data.data.items[0]).toMatchObject({
      regen: null,
      regenFailedReason: 'LIMIT_OUT',
    });
    expect(s.tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(s.tasks.completeOperation).toHaveBeenCalledWith(REGEN_OP, expect.any(Function));
  });
});

describe('AnalysisWriteHandler: the reasons of a regeneration are recorded at once (F07-2b, /fix 3, Q2)', () => {
  const REGEN_OP = 'op2';
  const ready = rowOf({ status: 'ready' });
  const regenTask = task({ draftId: 'd1', index: 0 }, REGEN_OP);

  it('a source that did not open and its statement: the reason is in steps[].dropped and droppedSources together with the result', async () => {
    const s = setup(ready);
    jest.spyOn(s.handler, 'contextOf').mockResolvedValue({
      chapters: [],
      stored: EMPTY_BOOK_ANALYSIS,
      bookTitle: 'Book',
      author: 'Ann Author',
    } as never);
    const fetcher = (s.handler as unknown as { fetcher: { fetchMany: jest.Mock } }).fetcher;
    fetcher.fetchMany.mockResolvedValue([
      { ok: true, text: 'Book by Ann Author', host: 'a.example', url: 'https://a.example/1' },
      {
        ok: false,
        reason: 'HTTP_STATUS',
        status: 404,
        host: 'b.example',
        url: 'https://b.example/2',
      },
    ]);
    mocked(runQualityLoop).mockResolvedValue({
      ...LOOP_OK,
      draft: {
        blocks: {
          context: 'Kept.\n\nDropped.',
          sources: [
            { title: 'A', url: 'https://a.example/1' },
            { title: 'B', url: 'https://b.example/2' },
          ],
        },
        themeLinks: null,
        refs: { facts: {}, context: [[0], [1]], reception: [], timeline: [], adaptations: [] },
        droppedQuotes: [],
        fixes: [],
      },
    } as never);
    const regen = { operationId: REGEN_OP, remark: null, pending: null, previous: null };
    const data = () =>
      dataOf({
        steps: [stepRow(1), stepRow(2), stepRow(3), stepRow(4), stepRow(5)],
        items: [item({ target: 'context', step: 5, regen })],
      });
    s.fields.read.mockResolvedValue(data());
    s.fields.mutate.mockImplementation(savedBy(data));
    await s.handler.handler.run(regenTask, ctx);
    const result = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(result.data.items[0]).toMatchObject({ outcome: 'waiting', value: 'Kept.' });
    expect(result.data.steps.find((x) => x.step === 5)?.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SOURCE_UNREACHABLE', path: 'sources.1' }),
        expect.objectContaining({ code: 'SOURCE_UNVERIFIED', path: 'context.1' }),
      ]),
    );
    expect(result.data.droppedSources).toEqual([
      { title: 'B', host: 'b.example', reason: 'SOURCE_UNREACHABLE' },
    ]);
  });
});

describe('AnalysisWriteHandler: the remark of a linked theme reaches the regenerated themes (F07-2b, /fix 3)', () => {
  const REGEN_OP = 'op2';
  const ready = rowOf({ status: 'ready' });
  const regenTask = task({ draftId: 'd1', index: 0 }, REGEN_OP);

  it('the code remark on the link of a hero is kept with the themes; a remark of another block is not', async () => {
    const s = setup(ready);
    const regen = { operationId: REGEN_OP, remark: null, pending: null, previous: null };
    const data = () => dataOf({ items: [item({ target: 'themes', step: 3, regen })] });
    s.fields.read.mockResolvedValue(data());
    s.fields.mutate.mockImplementation(savedBy(data));
    jest
      .spyOn(
        s.handler as unknown as { produceStep: () => Promise<StepRecord | null> },
        'produceStep',
      )
      .mockResolvedValue({
        step: {
          ...stepRow(3),
          remarks: [
            {
              code: 'IMPORT_INVALID',
              where: 'characters.anna.themeKeys',
              note: 'keep',
              by: 'code',
            },
            { code: 'STYLE_POOR', where: 'mainIdea', note: 'other', by: 'review' },
          ],
        } as never,
        draft: {
          blocks: { themes: [{ key: 'sin', title: 'Sin' }] } as never,
          themeLinks: null,
          droppedQuotes: [],
          fixes: [],
        },
        invalid: new Set(),
        review: { kind: 'answered', model: 'r' },
      });
    await s.handler.handler.run(regenTask, ctx);
    const result = (await s.fields.mutate.mock.results[0].value) as { data: AnalysisWriteData };
    expect(result.data.items[0].remarks.map((r) => r.where)).toEqual(['characters.anna.themeKeys']);
    expect(result.data.items[0].verdict).toBe('flags');
  });
});
