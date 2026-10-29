import { LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ChunkRunStepsService } from './chunk-run-steps.service';
import { ContextRunStepsService } from './context-run-steps.service';
import { MetadataDraftRunStepsService } from './metadata-draft-run-steps.service';
import { CLEAR_STOP, RunStepSupportService } from './run-step-support.service';
import { TranslationRunTasksHandler } from './translation-run-tasks.handler';
import { UNRESUMABLE_REASONS } from './translation-run.constants';

/**
 * Тупиковые причины паузы - один источник (`UNRESUMABLE_REASONS`): ими же обработчик отвечает
 * исполнителю, и с ними же «продолжить» не ставит задач, не читая запуск.
 */

function setup() {
  const db = { translationRun: { findUnique: jest.fn().mockResolvedValue(null) } };
  const handler = new TranslationRunTasksHandler(
    db as unknown as PrismaService,
    {} as LlmTaskService,
    {} as RunStepSupportService,
    {} as ContextRunStepsService,
    {} as ChunkRunStepsService,
    {} as MetadataDraftRunStepsService,
  );
  return { handler, db };
}

describe('TranslationRunTasksHandler', () => {
  it('отвечает исполнителю тупиковыми причинами из константы', () => {
    expect(setup().handler.unresumableReasons).toBe(UNRESUMABLE_REASONS);
  });

  it.each(UNRESUMABLE_REASONS)(
    '«продолжить» на паузе %s - задач нет, запуск не читается',
    async (reason) => {
      const { handler, db } = setup();
      const op = { id: 'op1', pauseReason: reason } as LlmOperation;
      await expect(handler.resumeTasks(op)).resolves.toEqual([]);
      expect(db.translationRun.findUnique).not.toHaveBeenCalled();
    },
  );

  it('«продолжить» на другой паузе читает запуск', async () => {
    const { handler, db } = setup();
    const op = { id: 'op1', pauseReason: 'LIMIT_REACHED' } as LlmOperation;
    await expect(handler.resumeTasks(op)).resolves.toEqual([]);
    expect(db.translationRun.findUnique).toHaveBeenCalledTimes(1);
  });
});

/** Обработчик на подменённых базе, задачах и классах шагов: что делает каждая точка входа. */
function full(lang: unknown = null) {
  const tx = { translationRunLanguage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const db = {
    translationRunLanguage: {
      findUnique: jest.fn().mockResolvedValue(lang),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const tasks = {
    failOperation: jest.fn(async (_id: string, fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    pauseOperation: jest.fn(
      async (_id: string, _reason: string, fn?: (t: typeof tx) => Promise<void>) => fn?.(tx),
    ),
  };
  const support = {
    completeIfFinished: jest.fn().mockResolvedValue(undefined),
    isStale: jest.fn().mockResolvedValue(false),
    closeOnStale: jest.fn(),
  };
  const context = { awaitContext: jest.fn().mockResolvedValue({ kind: 'continue' }) };
  const chunks = {
    startChapter: jest.fn().mockResolvedValue({ kind: 'continue' }),
    chapterStep: jest.fn().mockResolvedValue({ kind: 'continue' }),
  };
  const metadataDraft = { draftStep: jest.fn().mockResolvedValue({ kind: 'continue' }) };
  const handler = new TranslationRunTasksHandler(
    db as unknown as PrismaService,
    tasks as unknown as LlmTaskService,
    support as unknown as RunStepSupportService,
    context as unknown as ContextRunStepsService,
    chunks as unknown as ChunkRunStepsService,
    metadataDraft as unknown as MetadataDraftRunStepsService,
  );
  return { handler, db, tx, tasks, support, context, chunks, metadataDraft };
}

const task = { operationId: 'op1', payload: { runLanguageId: 'l1' } } as unknown as LlmTask;
const ctx = {} as LlmTaskContext;
const UNFINISHED = { in: ['pending', 'running'] };
const row = (patch: Record<string, unknown> = {}) => ({
  id: 'l1',
  status: 'running',
  glossaryId: 'g1',
  chapterNumber: 2,
  bookVersionId: null,
  draftCreatedAt: null,
  metadata: null,
  run: { id: 'r1', dossierId: 'd1' },
  ...patch,
});

describe('TranslationRunTasksHandler.run: выбор шага', () => {
  it('строки языка нет - операция в отказ, недоделанные языки failed той же транзакцией', async () => {
    const { handler, tx, tasks } = full(null);
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { run: { operationId: 'op1' }, status: UNFINISHED },
      data: { status: 'failed' },
    });
  });

  it.each(['done', 'failed', 'cancelled'])(
    'язык %s - только закрытие запуска, шаги не зовутся',
    async (status) => {
      const { handler, support, chunks, context } = full(row({ status }));
      await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
      expect(support.completeIfFinished).toHaveBeenCalledTimes(1);
      expect(chunks.chapterStep).not.toHaveBeenCalled();
      expect(context.awaitContext).not.toHaveBeenCalled();
    },
  );

  it('pending становится running условием статуса, затем шаг главы', async () => {
    const lang = row({ status: 'pending' });
    const { handler, db, chunks } = full(lang);
    await handler.handler.run(task, ctx);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: 'pending' },
      data: { status: 'running' },
    });
    expect(chunks.chapterStep).toHaveBeenCalledTimes(1);
    expect(chunks.chapterStep).toHaveBeenCalledWith(lang, 2, ctx);
  });

  it.each([
    ['досье', { run: { id: 'r1', dossierId: null } }],
    ['глоссария', { glossaryId: null }],
  ])('без %s - шаг контекста, главы не трогаются', async (_what, patch) => {
    const lang = row(patch);
    const { handler, context, chunks } = full(lang);
    await handler.handler.run(task, ctx);
    expect(context.awaitContext).toHaveBeenCalledTimes(1);
    expect(context.awaitContext).toHaveBeenCalledWith(lang);
    expect(chunks.chapterStep).not.toHaveBeenCalled();
  });

  it('ответ metadata принят и черновик начат - шаг черновика', async () => {
    const result = { title: 'T' };
    const lang = row({ bookVersionId: 'bv1', metadata: { attempts: [], result } });
    const { handler, metadataDraft, chunks } = full(lang);
    await handler.handler.run(task, ctx);
    expect(metadataDraft.draftStep).toHaveBeenCalledTimes(1);
    expect(metadataDraft.draftStep).toHaveBeenCalledWith(lang, ctx, result);
    expect(chunks.chapterStep).not.toHaveBeenCalled();
  });

  it('ответ metadata без начатого черновика - не шаг черновика, а главы', async () => {
    const lang = row({ metadata: { attempts: [], result: { title: 'T' } } });
    const { handler, metadataDraft, chunks } = full(lang);
    await handler.handler.run(task, ctx);
    expect(metadataDraft.draftStep).not.toHaveBeenCalled();
    expect(chunks.chapterStep).toHaveBeenCalledTimes(1);
  });

  it('глава не выбрана - выбор первой главы', async () => {
    const lang = row({ chapterNumber: null });
    const { handler, chunks } = full(lang);
    await handler.handler.run(task, ctx);
    expect(chunks.startChapter).toHaveBeenCalledTimes(1);
    expect(chunks.startChapter).toHaveBeenCalledWith(lang, null, ctx);
    expect(chunks.chapterStep).not.toHaveBeenCalled();
  });
});

describe('TranslationRunTasksHandler: «продолжить», отмена, провал задачи', () => {
  const op = { id: 'op1' } as LlmOperation;
  const runTx = (run: unknown) => ({
    translationRun: { findUnique: jest.fn().mockResolvedValue(run) },
    translationRunLanguage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  });
  const staleRun = { id: 'r1', dossierFingerprint: 'fp' };

  it('исходник устарел, живого черновика нет, языки ждут - отказ, причины не сбрасываются', async () => {
    const { handler, support } = full();
    support.isStale.mockResolvedValue(true);
    support.closeOnStale.mockResolvedValue({ hasLiveDraft: false, waiting: ['l1'] });
    const tx = runTx(staleRun);
    await expect(
      handler.onResumed(op, tx as unknown as Prisma.TransactionClient),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'LLM_OPERATION_NOT_RESUMABLE' }) as unknown,
    });
    expect(support.isStale).toHaveBeenCalledTimes(1);
    expect(support.isStale).toHaveBeenCalledWith(staleRun, tx);
    expect(support.closeOnStale).toHaveBeenCalledTimes(1);
    expect(support.closeOnStale).toHaveBeenCalledWith(tx, 'r1');
    expect(tx.translationRunLanguage.updateMany).not.toHaveBeenCalled();
  });

  it('исходник устарел, черновика нет, но никто не ждёт - не отказ, причины сбрасываются', async () => {
    const { handler, support } = full();
    support.isStale.mockResolvedValue(true);
    support.closeOnStale.mockResolvedValue({ hasLiveDraft: false, waiting: [] });
    const tx = runTx(staleRun);
    await handler.onResumed(op, tx as unknown as Prisma.TransactionClient);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { run: { operationId: 'op1' }, status: UNFINISHED },
      data: CLEAR_STOP,
    });
  });

  it('исходник не устарел - решение о тупике не принимается, причины сбрасываются', async () => {
    const { handler, support } = full();
    const tx = runTx(staleRun);
    await handler.onResumed(op, tx as unknown as Prisma.TransactionClient);
    expect(support.closeOnStale).not.toHaveBeenCalled();
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
  });

  it('исходник устарел, но черновик пишется - причины недоделанных языков сбрасываются', async () => {
    const { handler, support } = full();
    support.isStale.mockResolvedValue(true);
    support.closeOnStale.mockResolvedValue({ hasLiveDraft: true, waiting: ['l1'] });
    const tx = runTx(staleRun);
    await handler.onResumed(op, tx as unknown as Prisma.TransactionClient);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { run: { operationId: 'op1' }, status: UNFINISHED },
      data: CLEAR_STOP,
    });
  });

  it('отмена - cancelled только недоделанным языкам', async () => {
    const { handler } = full();
    const tx = runTx(null);
    await handler.onCancelled(op, tx as unknown as Prisma.TransactionClient);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { run: { operationId: 'op1' }, status: UNFINISHED },
      data: { status: 'cancelled' },
    });
  });

  it('провал по деньгам - пауза своей причиной и код отказа языку той же транзакцией', async () => {
    const { handler, tasks, tx } = full();
    await handler.handler.onFailed?.(task, 'LLM_INSUFFICIENT_FUNDS');
    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(tasks.pauseOperation).toHaveBeenCalledWith(
      'op1',
      'INSUFFICIENT_FUNDS',
      expect.any(Function),
    );
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { reason: 'LLM_INSUFFICIENT_FUNDS' },
    });
  });

  it('иной провал - STEP_FAILED; без языка в задаче код никуда не пишется', async () => {
    const { handler, tasks } = full();
    const bare = { operationId: 'op1', payload: {} } as unknown as LlmTask;
    await handler.handler.onFailed?.(bare, 'SOMETHING_ELSE');
    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(tasks.pauseOperation).toHaveBeenCalledWith('op1', 'STEP_FAILED', undefined);
  });
});
