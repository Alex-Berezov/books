import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmError, llmDisabled, llmModelsUnavailable } from '../../llm/llm.errors';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { AnalysisWriteService } from '../analysis-write/analysis-write.service';
import { SummaryWriteService } from '../summary-write/summary-write.service';
import {
  ANALYSIS_AUTOSTART_TASK_KIND,
  AUTOSTART_DUPLICATE,
  AUTOSTART_TASK_KINDS,
  autostartKindOfTask,
  CONTENT_AUTOSTART_TASK_KIND,
  AUTOSTART_SKIPPED_EXISTING,
  AUTOSTART_SKIPPED_IN_PROGRESS,
  AUTOSTART_SKIPPED_LLM_DISABLED,
} from './content-autostart.constants';
import {
  AUTOSTART_RETRY_DELAY_MS,
  AUTOSTART_RETRY_WINDOW_MS,
  autostartOutcome,
  ContentAutostartHandler,
} from './content-autostart.handler';

/**
 * Задача автозапуска раздела (`F06-5`; `tech.md` §4 п.2-п.4; решения арбитра `F06 | F06-5`, Р3, Р6):
 * старт хода без отбрасывания прежних; пропуск - причина в операции, строки нет; окончательный отказ
 * старта - строка `failed` на операции автозапуска; временный отказ и сбой не по отказу - повтор.
 */

const task = {
  id: 't1',
  kind: 'content_autostart',
  operationId: 'auto1',
  payload: { runLanguageId: 'l1' },
} as unknown as LlmTask;
const ctx = { signal: new AbortController().signal } as unknown as LlmTaskContext;

function setup(lang: unknown = { id: 'l1', runId: 'r1', status: 'done', bookVersionId: 'v-fr' }) {
  const tx = {
    llmOperation: { update: jest.fn().mockResolvedValue({}) },
    contentDraft: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    translationRunLanguage: { findUnique: jest.fn().mockResolvedValue(lang) },
    contentDraft: { findFirst: jest.fn().mockResolvedValue(null) },
    llmOperation: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ createdById: 'u1', status: 'active', createdAt: new Date() }),
    },
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ language: 'fr' }) },
  };
  const tasks = {
    completeOperation: jest.fn(async (_id: string, fn?: (t: typeof tx) => Promise<void>) => {
      if (fn) await fn(tx);
      return true;
    }),
    failOperation: jest.fn().mockResolvedValue(true),
  };
  const summaryWrite = { start: jest.fn().mockResolvedValue({}) };
  const analysisWrite = { start: jest.fn().mockResolvedValue({}) };
  const handler = new ContentAutostartHandler(
    prisma as unknown as PrismaService,
    tasks as unknown as LlmTaskService,
    summaryWrite as unknown as SummaryWriteService,
    analysisWrite as unknown as AnalysisWriteService,
  );
  return { handler, prisma, tasks, summaryWrite, analysisWrite, tx };
}

describe('autostartOutcome', () => {
  it.each([
    [AUTOSTART_SKIPPED_EXISTING, AUTOSTART_SKIPPED_EXISTING],
    [AUTOSTART_SKIPPED_IN_PROGRESS, AUTOSTART_SKIPPED_IN_PROGRESS],
    ['LLM_DISABLED', AUTOSTART_SKIPPED_LLM_DISABLED],
    // Частичный индекс строящегося хода: пропуск, слот не занимается (`tech.md` §4 п.4).
    ['DRAFT_IN_PROGRESS', AUTOSTART_SKIPPED_IN_PROGRESS],
  ])('%s - пропуск с причиной %s', (code, reason) => {
    expect(autostartOutcome(code)).toEqual({ kind: 'skip', reason });
  });

  it.each([AUTOSTART_DUPLICATE, 'HTTP_404'])('%s - тихо', (code) => {
    expect(autostartOutcome(code)).toEqual({ kind: 'quiet' });
  });

  it.each(['LLM_MODELS_UNAVAILABLE', 'LLM_TASK_PAIR_BUSY', 'HTTP_400', 'HTTP_500', 'HTTP_503'])(
    '%s - временный или без кода: повтор, а не строка failed',
    (code) => {
      expect(autostartOutcome(code)).toEqual({ kind: 'retry' });
    },
  );

  it.each([
    'LLM_CEILING_REACHED',
    'DOSSIER_TOO_LONG',
    'DRAFT_LIMIT_TOO_LOW',
    'DOSSIER_STALE',
    'DRAFT_DOSSIER_MISSING',
    'SOURCE_HAS_NO_CHAPTERS',
  ])('%s - окончательный отказ старта: строка failed', (code) => {
    expect(autostartOutcome(code)).toEqual({ kind: 'fail', reason: code });
  });
});

describe('ContentAutostartHandler', () => {
  it('старт хода - со ссылками на язык и запуск, автором запуска; операция закрыта без причины', async () => {
    const { handler, summaryWrite, tasks, tx } = setup();
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(summaryWrite.start).toHaveBeenCalledTimes(1);
    expect(summaryWrite.start).toHaveBeenCalledWith('v-fr', undefined, 'u1', {
      translationRunLanguageId: 'l1',
      translationRunId: 'r1',
    });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(0);
    expect(tx.contentDraft.create).toHaveBeenCalledTimes(0);
  });

  describe('вид хода по виду задачи (F07-3b; решения арбитра F07 | F07-3b)', () => {
    const analysisTask = { ...task, kind: ANALYSIS_AUTOSTART_TASK_KIND } as LlmTask;

    it('analysis_write - стартует ход анализа, а не пересказа', async () => {
      const { handler, summaryWrite, analysisWrite } = setup();
      await expect(handler.handler.run(analysisTask, ctx)).resolves.toEqual({ kind: 'done' });
      expect(analysisWrite.start).toHaveBeenCalledTimes(1);
      expect(analysisWrite.start).toHaveBeenCalledWith('v-fr', undefined, 'u1', {
        translationRunLanguageId: 'l1',
        translationRunId: 'r1',
      });
      expect(summaryWrite.start).toHaveBeenCalledTimes(0);
    });

    it('повтор ищет уже записанный ход своего вида: ход пересказа языка анализ не закрывает', async () => {
      const { handler, prisma, analysisWrite } = setup();
      await handler.handler.run(analysisTask, ctx);
      expect(prisma.contentDraft.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.contentDraft.findFirst).toHaveBeenCalledWith({
        where: { translationRunLanguageId: 'l1', kind: 'analysis_write' },
        select: { id: true },
      });
      expect(analysisWrite.start).toHaveBeenCalledTimes(1);
    });

    it('отказ старта анализа - строка failed вида analysis_write', async () => {
      const { handler, analysisWrite, tx } = setup();
      analysisWrite.start.mockRejectedValueOnce(llmTaskConflict('LLM_CEILING_REACHED', 'x'));
      await handler.handler.run(analysisTask, ctx);
      expect(tx.contentDraft.create).toHaveBeenCalledTimes(1);
      expect(tx.contentDraft.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'analysis_write',
          failedReason: 'LLM_CEILING_REACHED',
        }),
      });
    });

    it('content_autostart (и задача прежнего образа) - пересказ; payload.kind не читается', async () => {
      const { handler, summaryWrite, analysisWrite } = setup();
      await handler.handler.run(task, ctx);
      await handler.handler.run(
        { ...task, payload: { runLanguageId: 'l1', kind: 'analysis_write' } } as LlmTask,
        ctx,
      );
      expect(summaryWrite.start).toHaveBeenCalledTimes(2);
      expect(analysisWrite.start).toHaveBeenCalledTimes(0);
    });

    it('вид задачи по виду хода и обратно', () => {
      expect(AUTOSTART_TASK_KINDS).toEqual({
        summary_write: CONTENT_AUTOSTART_TASK_KIND,
        analysis_write: ANALYSIS_AUTOSTART_TASK_KIND,
      });
      expect(autostartKindOfTask(ANALYSIS_AUTOSTART_TASK_KIND)).toBe('analysis_write');
      expect(autostartKindOfTask(CONTENT_AUTOSTART_TASK_KIND)).toBe('summary_write');
      // Чужой вид - ошибка регистрации, а не молчаливый старт пересказа.
      expect(() => autostartKindOfTask('content_draft')).toThrow('content_draft');
    });
  });

  it('повтор после старта, успевшего записать ход, - закрыть без причины, старт не зовётся', async () => {
    const { handler, prisma, summaryWrite, tasks, tx } = setup();
    prisma.contentDraft.findFirst.mockResolvedValueOnce({ id: 'd1' });
    await handler.handler.run(task, ctx);
    expect(prisma.contentDraft.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.contentDraft.findFirst).toHaveBeenCalledWith({
      where: { translationRunLanguageId: 'l1', kind: 'summary_write' },
      select: { id: true },
    });
    expect(summaryWrite.start).toHaveBeenCalledTimes(0);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(0);
  });

  it.each([
    [llmTaskConflict(AUTOSTART_SKIPPED_EXISTING, 'x'), AUTOSTART_SKIPPED_EXISTING],
    [llmTaskConflict(AUTOSTART_SKIPPED_IN_PROGRESS, 'x'), AUTOSTART_SKIPPED_IN_PROGRESS],
    [llmTaskConflict('DRAFT_IN_PROGRESS', 'x'), AUTOSTART_SKIPPED_IN_PROGRESS],
    [llmDisabled(), AUTOSTART_SKIPPED_LLM_DISABLED],
  ])('пропуск - причина в операции автозапуска, строки хода нет (%#)', async (error, reason) => {
    const { handler, summaryWrite, tx } = setup();
    summaryWrite.start.mockRejectedValueOnce(error);
    await handler.handler.run(task, ctx);
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(1);
    expect(tx.llmOperation.update).toHaveBeenCalledWith({
      where: { id: 'auto1' },
      data: { skipReason: reason },
    });
    expect(tx.contentDraft.create).toHaveBeenCalledTimes(0);
  });

  it('отказ старта (потолок) - строка failed с причиной на операции автозапуска', async () => {
    const { handler, summaryWrite, tx } = setup();
    summaryWrite.start.mockRejectedValueOnce(llmTaskConflict('LLM_CEILING_REACHED', 'x'));
    await handler.handler.run(task, ctx);
    expect(tx.contentDraft.create).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.create).toHaveBeenCalledWith({
      data: {
        bookVersionId: 'v-fr',
        kind: 'summary_write',
        status: 'failed',
        failedReason: 'LLM_CEILING_REACHED',
        language: 'fr',
        operationId: 'auto1',
        translationRunLanguageId: 'l1',
      },
    });
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(0);
  });

  it('версию удалили между отказом старта и записью строки - закрыть без строки', async () => {
    const { handler, prisma, summaryWrite, tasks, tx } = setup();
    summaryWrite.start.mockRejectedValueOnce(llmTaskConflict('LLM_CEILING_REACHED', 'x'));
    prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.create).toHaveBeenCalledTimes(0);
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(0);
  });

  it('слот уже занят (повтор задачи) - операция закрыта без второй строки', async () => {
    const { handler, summaryWrite, tasks, tx } = setup();
    summaryWrite.start.mockRejectedValueOnce(llmTaskConflict('DOSSIER_STALE', 'x'));
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    tasks.completeOperation.mockRejectedValueOnce(p2002);
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(2);
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(0);
  });

  it('второй автозапуск языка и удалённая версия - тихо, без причины и строки', async () => {
    for (const error of [
      llmTaskConflict(AUTOSTART_DUPLICATE, 'x'),
      new NotFoundException('Book version not found'),
    ]) {
      const { handler, summaryWrite, tx, tasks } = setup();
      summaryWrite.start.mockRejectedValueOnce(error);
      await handler.handler.run(task, ctx);
      expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
      expect(tx.llmOperation.update).toHaveBeenCalledTimes(0);
      expect(tx.contentDraft.create).toHaveBeenCalledTimes(0);
    }
  });

  it.each([
    ['временный отказ (список моделей)', llmModelsUnavailable(), 'LLM_MODELS_UNAVAILABLE'],
    ['отказ без кода', new BadRequestException('bad'), 'HTTP_400'],
    ['сбой не по отказу старта', new Error('connection reset'), 'STEP_ERROR'],
  ])(
    '%s в окне - wait с кодом и паузой, операция не закрыта, слот не занят',
    async (_name, error, code) => {
      const { handler, summaryWrite, tasks, tx } = setup();
      summaryWrite.start.mockRejectedValueOnce(error);
      const before = Date.now();
      const result = await handler.handler.run(task, ctx);
      expect(result).toMatchObject({ kind: 'wait', reason: code });
      const runAfter = (result as { runAfter: Date }).runAfter.getTime();
      expect(runAfter).toBeGreaterThanOrEqual(before + AUTOSTART_RETRY_DELAY_MS);
      expect(runAfter).toBeLessThanOrEqual(Date.now() + AUTOSTART_RETRY_DELAY_MS);
      expect(tasks.completeOperation).toHaveBeenCalledTimes(0);
      expect(tasks.failOperation).toHaveBeenCalledTimes(0);
      expect(tx.contentDraft.create).toHaveBeenCalledTimes(0);
    },
  );

  it('временный отказ после окна (задача простояла в очереди дольше часа) - операция failed, повтора нет', async () => {
    const { handler, prisma, summaryWrite, tasks } = setup();
    prisma.llmOperation.findUnique.mockResolvedValueOnce({
      createdById: 'u1',
      status: 'active',
      createdAt: new Date(Date.now() - AUTOSTART_RETRY_WINDOW_MS - 1000),
    });
    summaryWrite.start.mockRejectedValueOnce(llmModelsUnavailable());
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).toHaveBeenCalledWith('auto1');
    expect(tasks.completeOperation).toHaveBeenCalledTimes(0);
  });

  it('операцию сняли до старта - хода нет, статус операции не трогается', async () => {
    const { handler, prisma, summaryWrite, tasks } = setup();
    prisma.llmOperation.findUnique.mockResolvedValueOnce({
      createdById: 'u1',
      status: 'cancelled',
      createdAt: new Date(),
    });
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'continue' });
    expect(summaryWrite.start).toHaveBeenCalledTimes(0);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(0);
    expect(tasks.failOperation).toHaveBeenCalledTimes(0);
  });

  it('отказ модуля LLM и остановка процесса - наружу, разбирает воркер', async () => {
    const llmError = new LlmError('LLM_OPERATION_NOT_ACTIVE', 'x');
    const first = setup();
    first.summaryWrite.start.mockRejectedValueOnce(llmError);
    await expect(first.handler.handler.run(task, ctx)).rejects.toBe(llmError);
    const stop = new AbortController();
    stop.abort();
    const second = setup();
    const failure = new Error('aborted');
    second.summaryWrite.start.mockRejectedValueOnce(failure);
    await expect(
      second.handler.handler.run(task, { signal: stop.signal } as unknown as LlmTaskContext),
    ).rejects.toBe(failure);
    expect(second.tasks.completeOperation).toHaveBeenCalledTimes(0);
  });

  it('язык не done или без черновика - хода нет, операция закрыта', async () => {
    for (const lang of [
      null,
      { id: 'l1', runId: 'r1', status: 'failed', bookVersionId: 'v-fr' },
      { id: 'l1', runId: 'r1', status: 'done', bookVersionId: null },
    ]) {
      const { handler, summaryWrite, tasks } = setup(lang);
      await handler.handler.run(task, ctx);
      expect(summaryWrite.start).toHaveBeenCalledTimes(0);
      expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    }
  });

  it('сбой после повторов - операция failed', async () => {
    const { handler, tasks } = setup();
    await handler.handler.onFailed?.(task, 'X');
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).toHaveBeenCalledWith('auto1');
  });
});
