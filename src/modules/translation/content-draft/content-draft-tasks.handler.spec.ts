import { ContentDraft, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ContentDraftTasksHandler } from './content-draft-tasks.handler';
import { ContentDraftService } from './content-draft.service';
import { SummaryWriteHandler } from '../summary-write/summary-write.handler';
import { AnalysisWriteHandler } from '../analysis-write/analysis-write.handler';

/**
 * Обработчик операций `draft` на подменённой базе: у задачи `content_draft` своих шагов нет -
 * строящаяся строка снятого вида (Summary `F05-10`, Analysis `F05-11`) отбрасывается путём дренажа
 * (F06-3, А1; F07-3a), строка хода под задачей заготовки - отказ; «Continue», отмена и деньги.
 */

const draftRow = (patch: Partial<ContentDraft> = {}): ContentDraft => ({
  id: 'd1',
  bookVersionId: 'v1',
  kind: 'analysis',
  status: 'building',
  language: 'en',
  operationId: 'op1',
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

const task = { id: 't1', operationId: 'op1', payload: { draftId: 'd1' } } as unknown as LlmTask;

/** Шагу снятого вида контекст исполнителя не нужен: ни вызова модели, ни аренды. */
const ctx = {} as LlmTaskContext;

function setup(row: ContentDraft | null) {
  const tx = { contentDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    contentDraft: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const run = (fn?: (t: typeof tx) => Promise<void>) =>
    (fn ? fn(tx) : Promise.resolve()).then(() => true);
  const tasks = {
    completeOperation: jest.fn((_id: string, fn?: (t: typeof tx) => Promise<void>) => run(fn)),
    failOperation: jest.fn((_id: string, fn?: (t: typeof tx) => Promise<void>) => run(fn)),
    pauseOperation: jest.fn().mockResolvedValue(true),
  };
  const drafts = {
    languageOf: jest.fn().mockResolvedValue('en'),
    discardRetired: jest.fn().mockResolvedValue(undefined),
  };
  const summaryWrite = {
    regenResume: jest.fn().mockResolvedValue([]),
    onRegenCancelled: jest.fn().mockResolvedValue(undefined),
  };
  const analysisWrite = {
    regenResume: jest.fn().mockResolvedValue([]),
    onRegenCancelled: jest.fn().mockResolvedValue(undefined),
  };
  const handler = new ContentDraftTasksHandler(
    prisma as unknown as PrismaService,
    tasks as unknown as LlmTaskService,
    drafts as unknown as ContentDraftService,
    summaryWrite as unknown as SummaryWriteHandler,
    analysisWrite as unknown as AnalysisWriteHandler,
  );
  return { handler, prisma, tasks, tx, drafts, summaryWrite, analysisWrite };
}

describe('ContentDraftTasksHandler (F06-3, F07-3a)', () => {
  it.each(['summary_sections', 'summary_full', 'summary_brief', 'analysis'] as const)(
    'a building %s draft (retired kind) is discarded by the drain path, not failed',
    async (kind) => {
      const { handler, tasks, drafts } = setup(draftRow({ kind }));
      await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
      expect(drafts.discardRetired).toHaveBeenCalledTimes(1);
      expect(drafts.discardRetired).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'd1', operationId: 'op1' }),
      );
      expect(tasks.failOperation).not.toHaveBeenCalled();
    },
  );

  it.each(['summary_write', 'analysis_write'] as const)(
    'a %s run row under a draft task - DRAFT_INPUT_MISSING, not discarded as retired',
    async (kind) => {
      const { handler, tx, drafts } = setup(draftRow({ kind }));
      await handler.handler.run(task, ctx);
      expect(drafts.discardRetired).not.toHaveBeenCalled();
      expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'failed', failedReason: 'DRAFT_INPUT_MISSING' },
        }),
      );
    },
  );

  it('a retired draft that is no longer building - the step ends, nothing is discarded twice', async () => {
    const { handler, tasks, drafts } = setup(
      draftRow({ kind: 'summary_sections', status: 'discarded' }),
    );
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(drafts.discardRetired).not.toHaveBeenCalled();
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
  });

  it('a draft that is no longer building - the step ends, nothing is written', async () => {
    const { handler, tasks } = setup(draftRow({ status: 'discarded' }));
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
  });

  it('money refusals pause the operation with their reason, others - STEP_FAILED', async () => {
    const { handler, tasks } = setup(draftRow());
    await handler.handler.onFailed?.(task, 'LLM_BUDGET_EXCEEDED:ceiling');
    await handler.handler.onFailed?.(task, 'LLM_PROVIDER_ERROR');
    expect(tasks.pauseOperation.mock.calls).toEqual([
      ['op1', 'CEILING_REACHED'],
      ['op1', 'STEP_FAILED'],
    ]);
  });

  it('cancel from the operations page - failed DRAFT_CANCELLED; resume only a building draft', async () => {
    const { handler, prisma } = setup(draftRow());
    const tx = { contentDraft: { updateMany: jest.fn() } };
    await handler.onCancelled({ id: 'op1' } as never, tx as unknown as Prisma.TransactionClient);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { operationId: 'op1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_CANCELLED' },
    });
    await expect(handler.resumeTasks({ id: 'op1' } as never)).resolves.toEqual([
      expect.objectContaining({
        kind: 'content_draft',
        pairKey: 'op1:d1',
        payload: { draftId: 'd1' },
      }),
    ]);
    prisma.contentDraft.findUnique.mockResolvedValue(draftRow({ status: 'ready' }));
    await expect(handler.resumeTasks({ id: 'op1' } as never)).resolves.toEqual([]);
  });

  // Л1 `F07-1a`: строящийся ход анализа не уходит задачей заготовки (она отбила бы строку чужого
  // вида `DRAFT_INPUT_MISSING`); «Continue» хода анализа (`F07-1b`) ставит задачу `analysis_write`.
  it('«Continue» of a building analysis run enqueues the analysis_write task, not a draft task; cancel fails it like any row', async () => {
    const { handler, prisma } = setup(draftRow({ kind: 'analysis_write' }));
    await expect(handler.resumeTasks({ id: 'op1' } as never)).resolves.toEqual([
      expect.objectContaining({
        kind: 'analysis_write',
        operationId: 'op1',
        pairKey: 'op1:d1',
        payload: { draftId: 'd1' },
      }),
    ]);
    // Ход не строится (ready, failed, discarded) - продолжать нечего.
    prisma.contentDraft.findUnique.mockResolvedValue(
      draftRow({ kind: 'analysis_write', status: 'ready' }),
    );
    await expect(handler.resumeTasks({ id: 'op1' } as never)).resolves.toEqual([]);
    prisma.contentDraft.findUnique.mockResolvedValue(draftRow({ kind: 'analysis_write' }));
    const tx = { contentDraft: { updateMany: jest.fn() } };
    await handler.onCancelled({ id: 'op1' } as never, tx as unknown as Prisma.TransactionClient);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { operationId: 'op1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_CANCELLED' },
    });
  });
});

/**
 * Операция вида `draft` без строки - перегенерация текста хода (`F06-2`, Р2) или автозапуск (`F06-5`):
 * у перегенерации `translationRunId` нет никогда, автозапуск свою операцию закрывает сам - в ветку
 * перегенерации он не идёт ни на «Continue», ни на отмене (решение арбитра `F06 | F06-5`, Р4).
 */
describe('ContentDraftTasksHandler: операция автозапуска (F06-5)', () => {
  const tx = () =>
    ({ contentDraft: { updateMany: jest.fn() } }) as unknown as Prisma.TransactionClient;
  const autostartOp = { id: 'op1', translationRunId: 'r1' } as never;
  const regenOp = { id: 'op1', translationRunId: null } as never;

  it('без строки: Continue - пусто, отмена - без снятия отметок перегенерации', async () => {
    const { handler, summaryWrite } = setup(null);
    await expect(handler.resumeTasks(autostartOp)).resolves.toEqual([]);
    await handler.onCancelled(autostartOp, tx());
    expect(summaryWrite.regenResume).toHaveBeenCalledTimes(0);
    expect(summaryWrite.onRegenCancelled).toHaveBeenCalledTimes(0);
  });

  it('со строкой failed отказа старта: Continue - пусто, перегенерация не задета', async () => {
    const { handler, summaryWrite } = setup(
      draftRow({ kind: 'summary_write', status: 'failed', translationRunLanguageId: 'l1' }),
    );
    await expect(handler.resumeTasks(autostartOp)).resolves.toEqual([]);
    await handler.onCancelled(autostartOp, tx());
    expect(summaryWrite.regenResume).toHaveBeenCalledTimes(0);
    expect(summaryWrite.onRegenCancelled).toHaveBeenCalledTimes(0);
  });

  it('перегенерация (translationRunId нет) по-прежнему идёт в свою ветку', async () => {
    const { handler, summaryWrite } = setup(null);
    await handler.resumeTasks(regenOp);
    await handler.onCancelled(regenOp, tx());
    expect(summaryWrite.regenResume).toHaveBeenCalledTimes(1);
    expect(summaryWrite.onRegenCancelled).toHaveBeenCalledTimes(1);
  });

  it('перегенерация блока хода анализа (F07-1b): Continue ищет блок у хода анализа, если пересказ не нашёл; отмена снимает отметки у обоих видов', async () => {
    const { handler, summaryWrite, analysisWrite } = setup(null);
    const input = {
      kind: 'analysis_write',
      operationId: 'op1',
      payload: { draftId: 'd1', index: 2 },
    };
    analysisWrite.regenResume.mockResolvedValue([input]);
    await expect(handler.resumeTasks(regenOp)).resolves.toEqual([input]);
    expect(summaryWrite.regenResume).toHaveBeenCalledTimes(1);
    // Пересказ нашёл свой текст - ход анализа не опрашивается.
    summaryWrite.regenResume.mockResolvedValue([{ kind: 'summary_write' }]);
    analysisWrite.regenResume.mockClear();
    await handler.resumeTasks(regenOp);
    expect(analysisWrite.regenResume).not.toHaveBeenCalled();
    await handler.onCancelled(regenOp, tx());
    expect(analysisWrite.onRegenCancelled).toHaveBeenCalledTimes(1);
    expect(analysisWrite.onRegenCancelled).toHaveBeenCalledWith(regenOp, expect.anything());
    expect(summaryWrite.onRegenCancelled).toHaveBeenCalledTimes(1);
    expect(summaryWrite.onRegenCancelled).toHaveBeenCalledWith(regenOp, expect.anything());
  });
});
