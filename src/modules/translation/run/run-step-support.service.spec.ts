import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
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
import { RUN_LANGUAGE_UNFINISHED, UNRESUMABLE_REASONS } from './translation-run.constants';

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
  };
  const db = {
    translationRunLanguage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(open),
    },
  };
  const llm = { stageCallModels: jest.fn().mockResolvedValue(['m1', 'm2']) };
  const tasks = {
    completeOperation: jest.fn().mockResolvedValue(undefined),
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
    const { support, db, tasks } = setup(1);
    await expect(support.finishLanguage(lang)).resolves.toEqual({ kind: 'done' });
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.updateMany).toHaveBeenCalledWith({
      where: { id: 'l1', status: OPEN },
      data: { status: 'done', reason: null },
    });
    expect(tasks.completeOperation).not.toHaveBeenCalled();
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
