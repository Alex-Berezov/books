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

const stepRow = (step: 1 | 2 | 3): AnalysisStep => ({
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

  it('after step 3 the core is marked and the run is ready together with its operation; a run that stopped taking writes is only closed', async () => {
    const { handler, fields, tasks, tx } = setup();
    fields.read.mockResolvedValue(dataOf({ steps: [stepRow(1), stepRow(2), stepRow(3)] }));
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
  ])(
    '%s: the block stays, the reason is kept in regenFailedReason, nothing is decided',
    async (_name, outcome, reason) => {
      const s = regenSetup([item({ regen })]);
      s.produce.mockResolvedValue(outcome);
      await s.handler.handler.run(regenTask, ctx);
      expect(s.fields.mutate).not.toHaveBeenCalled();
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
