import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../../../prisma/prisma.service';
import { llmDisabled } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import {
  AUTOSTART_SKIPPED_LLM_DISABLED,
  CONTENT_AUTOSTART_TASK_KIND,
} from '../autostart/content-autostart.constants';
import { CHECK_NO_COMPLIANT_PROVIDER, CHECK_SEMANTIC_STAGE } from '../check/check.constants';
import { DRAFT_DELETED } from '../draft/draft.constants';
import {
  FINAL_CHECK_NO_COMPLIANT_PROVIDER,
  FINAL_CHECK_STAGE,
} from '../final-check/final-check.constants';
import { METADATA_NO_COMPLIANT_PROVIDER, METADATA_STAGE } from '../metadata/metadata.constants';
import {
  CLEAR_STOP,
  LanguageRow,
  noProviderReason,
  RunStepSupportService,
} from './run-step-support.service';
import {
  RUN_LANGUAGE_UNFINISHED,
  RUN_TX_OPTIONS,
  UNRESUMABLE_REASONS,
} from './translation-run.constants';

/**
 * Общее для шагов языка запуска на подменённых базе и сервисе задач: итоги языка пишутся
 * условием «язык не закрыт» и закрывают операцию, когда открытых не осталось; паузы - с тупиковыми
 * причинами; решение «исходник устарел» под замком закрывает языки своими кодами.
 */

const lang = { id: 'l1', runId: 'r1', run: { id: 'r1', operationId: 'op1' } } as LanguageRow;
const OPEN = { in: [...RUN_LANGUAGE_UNFINISHED] };

type Gate = (tx: unknown) => Promise<boolean>;
type Write = (tx: unknown) => Promise<void>;

function setup(open: number, languages: unknown[] = []) {
  const tx = {
    translationRunLanguage: {
      findMany: jest.fn().mockResolvedValue(languages),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    llmOperation: {
      create: jest.fn().mockResolvedValue({ id: 'auto1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const db = {
    translationRunLanguage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(open),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const llm = {
    stageCallModels: jest.fn().mockResolvedValue(['m1', 'm2']),
    operationData: jest.fn((input: Record<string, unknown>) =>
      Promise.resolve({ ...input, settingsSnapshot: {} }),
    ),
  };
  const tasks = {
    completeOperation: jest.fn().mockResolvedValue(undefined),
    enqueue: jest.fn().mockResolvedValue({ created: true, task: { id: 't1' } }),
    // Исполняет запись и решение под замком, как настоящий сервис задач.
    stopOrRepause: jest.fn(
      async (_op: string, _reason: string, write: Write, _keep: unknown, gate?: Gate) => {
        if (gate && !(await gate(tx))) return false;
        await write(tx);
        return true;
      },
    ),
  };
  const support = new RunStepSupportService(
    db as unknown as PrismaService,
    llm as unknown as LlmService,
    tasks as unknown as LlmTaskService,
  );
  return { support, db, tx, llm, tasks };
}

describe('RunStepSupportService: итоги языка', () => {
  it('failLanguage пишет failed условием «язык не закрыт» и закрывает операцию', async () => {
    const { support, db, tasks } = setup(0);
    await expect(support.failLanguage(lang, 'X_CODE', 'text')).resolves.toEqual({ kind: 'done' });
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: OPEN },
      data: { status: 'failed', reason: 'X_CODE', reasonText: 'text' },
    });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
  });

  it('finishLanguage не закрывает операцию, пока есть открытый язык', async () => {
    const { support, tx, tasks, llm } = setup(1);
    await expect(support.finishLanguage(lang)).resolves.toEqual({ kind: 'done' });
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: OPEN },
      data: { status: 'done', reason: null },
    });
    expect(tasks.completeOperation).not.toHaveBeenCalled();
    // Без «Write Summary» автозапуска нет: ни данных операции, ни строки, ни задачи (D2 `F05`).
    expect(llm.operationData).not.toHaveBeenCalled();
    expect(tx.llmOperation.create).not.toHaveBeenCalled();
    expect(tasks.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * Автозапуск раздела по `done` языка (`F06-5`; `tech.md` §4 п.1): операция и задача - в одной
 * транзакции с `done`, только если `done` записан этим вызовом; LLM выключен - `done` всё равно
 * записан, операция закрыта с причиной сразу; держатель ключа - ошибка в журнал, не отказ.
 */
describe('RunStepSupportService: автозапуск раздела', () => {
  const summaryLang = {
    id: 'l1',
    runId: 'r1',
    language: 'fr',
    bookVersionId: 'v-fr',
    run: { id: 'r1', operationId: 'op1', writeSummary: true, operation: { createdById: 'u1' } },
  } as unknown as LanguageRow;
  const opInput = {
    kind: 'draft',
    bookVersionId: 'v-fr',
    limitUsd: new Prisma.Decimal(0),
    createdById: 'u1',
    translationRunId: 'r1',
  };

  it('done записан - операция автозапуска и задача на неё в той же транзакции, своим ключом', async () => {
    const { support, db, tx, tasks, llm } = setup(0);
    await expect(support.finishLanguage(summaryLang)).resolves.toEqual({ kind: 'done' });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Транзакция с циклом записей - со своими timeout/maxWait (L-020).
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), RUN_TX_OPTIONS);
    expect(llm.operationData).toHaveBeenCalledTimes(1);
    expect(llm.operationData).toHaveBeenCalledWith(opInput);
    expect(tx.llmOperation.create).toHaveBeenCalledTimes(1);
    expect(tx.llmOperation.create).toHaveBeenCalledWith({
      data: { ...opInput, settingsSnapshot: {} },
      select: { id: true },
    });
    expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledWith(
      {
        kind: CONTENT_AUTOSTART_TASK_KIND,
        operationId: 'auto1',
        bookVersionId: 'v-fr',
        language: 'fr',
        payload: { runLanguageId: 'l1' },
        pairKey: 'autostart:l1:summary_write',
      },
      tx,
    );
    // Операция запуска закрывается после коммита - своя операция автозапуска нет.
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
  });

  it('done уже был записан (повтор шага) - второго автозапуска нет', async () => {
    const { support, tx, tasks } = setup(0);
    tx.translationRunLanguage.updateMany.mockResolvedValueOnce({ count: 0 });
    await support.finishLanguage(summaryLang);
    expect(tx.llmOperation.create).not.toHaveBeenCalled();
    expect(tasks.enqueue).not.toHaveBeenCalled();
  });

  it('LLM выключен в момент done - done записан, операция закрыта с причиной, задачи нет', async () => {
    const { support, tx, tasks, llm } = setup(0);
    llm.operationData.mockRejectedValueOnce(llmDisabled());
    await expect(support.finishLanguage(summaryLang)).resolves.toEqual({ kind: 'done' });
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: OPEN },
      data: { status: 'done', reason: null },
    });
    expect(tx.llmOperation.create).toHaveBeenCalledTimes(1);
    expect(tx.llmOperation.create).toHaveBeenCalledWith({
      data: { ...opInput, status: 'done', skipReason: AUTOSTART_SKIPPED_LLM_DISABLED },
      select: { id: true },
    });
    expect(tasks.enqueue).not.toHaveBeenCalled();
  });

  it('иной отказ данных операции (база, настройки) - не «LLM выключен»: шаг падает до done', async () => {
    const { support, db, tx, tasks, llm } = setup(0);
    const failure = new Error('connection terminated');
    llm.operationData.mockRejectedValueOnce(failure);
    await expect(support.finishLanguage(summaryLang)).rejects.toBe(failure);
    expect(db.$transaction).toHaveBeenCalledTimes(0);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(0);
    expect(tx.llmOperation.create).toHaveBeenCalledTimes(0);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(0);
  });

  it('ключ задачи занят - операция failed, ошибка в журнал и Sentry, done не откатывается', async () => {
    const { support, tx, tasks } = setup(0);
    tasks.enqueue.mockResolvedValueOnce({ created: false, holder: { id: 'held' } });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sentry = jest.spyOn(Sentry, 'captureMessage').mockImplementation(() => 'e1');
    await expect(support.finishLanguage(summaryLang)).resolves.toEqual({ kind: 'done' });
    expect(tx.llmOperation.update).toHaveBeenCalledTimes(1);
    expect(tx.llmOperation.update).toHaveBeenCalledWith({
      where: { id: 'auto1' },
      data: { status: 'failed' },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('held');
    expect(sentry).toHaveBeenCalledTimes(1);
    error.mockRestore();
    sentry.mockRestore();
  });
});

describe('RunStepSupportService: паузы', () => {
  it('pauseNoProvider: пауза с тупиковыми причинами, языку - причина этапа и опробованные модели', async () => {
    const { support, tasks, tx } = setup(0);
    await support.pauseNoProvider(lang, METADATA_STAGE, { model: 'm1', fallbacks: ['m2'] });
    expect(tasks.stopOrRepause).toHaveBeenCalledTimes(1);
    expect(tasks.stopOrRepause).toHaveBeenCalledWith(
      'op1',
      'NO_COMPLIANT_PROVIDER',
      expect.any(Function),
      UNRESUMABLE_REASONS,
    );
    expect(tx.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { reason: METADATA_NO_COMPLIANT_PROVIDER, reasonModels: ['m1', 'm2'] },
    });
  });

  it('noProviderReason: у каждого этапа свой код, неизвестный - общий', () => {
    expect(noProviderReason(CHECK_SEMANTIC_STAGE)).toBe(CHECK_NO_COMPLIANT_PROVIDER);
    expect(noProviderReason(METADATA_STAGE)).toBe(METADATA_NO_COMPLIANT_PROVIDER);
    expect(noProviderReason(FINAL_CHECK_STAGE)).toBe(FINAL_CHECK_NO_COMPLIANT_PROVIDER);
    expect(noProviderReason('translate')).toBe('LLM_NO_COMPLIANT_PROVIDER');
  });

  it('pauseStale без живого черновика - тупик запуска, язык на DOSSIER_STALE, шаг продолжается', async () => {
    const waiting = { id: 'l1', bookVersionId: null, draftCreatedAt: null };
    const { support, tasks, tx } = setup(1, [waiting]);
    await expect(support.pauseStale(lang)).resolves.toEqual({ kind: 'continue' });
    expect(tasks.stopOrRepause).toHaveBeenCalledTimes(1);
    expect(tasks.stopOrRepause).toHaveBeenCalledWith(
      'op1',
      'DOSSIER_STALE',
      expect.any(Function),
      UNRESUMABLE_REASONS,
      expect.any(Function),
    );
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: OPEN },
      data: { reason: 'DOSSIER_STALE' },
    });
    expect(tasks.completeOperation).not.toHaveBeenCalled();
  });

  it('pauseStale при живом черновике соседа - язык закрывается сам, операция не встаёт', async () => {
    const languages = [
      { id: 'l1', bookVersionId: null, draftCreatedAt: null },
      { id: 'l2', bookVersionId: 'v2', draftCreatedAt: new Date() },
    ];
    const { support, tasks, tx } = setup(1, languages);
    await expect(support.pauseStale(lang)).resolves.toEqual({ kind: 'done' });
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1'] }, status: OPEN },
      data: { ...CLEAR_STOP, status: 'failed', reason: 'DOSSIER_STALE' },
    });
    expect(tasks.completeOperation).not.toHaveBeenCalled();
  });

  it('closeOnStale: удалённый черновик закрывается DRAFT_DELETED', async () => {
    const deleted = { id: 'l3', bookVersionId: null, draftCreatedAt: new Date() };
    const { support, tx } = setup(0, [deleted]);
    const decision = await support.closeOnStale(tx as never, 'r1');
    expect(decision.deleted).toEqual(['l3']);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l3'] }, status: OPEN },
      data: { ...CLEAR_STOP, status: 'failed', reason: DRAFT_DELETED },
    });
  });
});
