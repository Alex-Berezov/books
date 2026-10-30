import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { demandContext } from '../dossier/context-demand';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { sourceFingerprint } from '../source-fingerprint';
import { ContextRunStepsService } from './context-run-steps.service';
import { CLEAR_STOP, LanguageRow, RunStepSupportService } from './run-step-support.service';
import { DOSSIER_LIMIT_TOO_LOW, RUN_TX_OPTIONS } from './translation-run.constants';

jest.mock('../dossier/context-demand', () => ({ demandContext: jest.fn() }));
jest.mock('../source-fingerprint', () => ({
  ...jest.requireActual<Record<string, unknown>>('../source-fingerprint'),
  sourceFingerprint: jest.fn(),
}));

/**
 * Досье запуска и глоссарий языка на подменённых базе и спросе на контекст: привязка досье
 * одна на запуск (первый язык), досье другой версии или правленый исходник не привязываются,
 * ожидание и остановка досье пишутся языку, не затирая лимит, записанный до трат.
 */

const demandMock = demandContext as jest.Mock;
const fingerprintMock = sourceFingerprint as jest.Mock;
const DOSSIER = { id: 'dos1', sourceVersionId: 'v1', fingerprint: 'fp1' };
const GLOSSARY = { id: 'g1' };

function lang(patch: Record<string, unknown> = {}, run: Record<string, unknown> = {}): LanguageRow {
  return {
    id: 'l1',
    language: 'es',
    waitingFor: null,
    run: { id: 'r1', operationId: 'op1', bookVersionId: 'v1', dossierId: null, ...run },
    ...patch,
  } as unknown as LanguageRow;
}

function setup(boundDossierId: string = 'dos1') {
  const tx = {
    translationRun: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ dossierId: boundDossierId }),
    },
    translationRunLanguage: { update: jest.fn().mockResolvedValue({}) },
  };
  const db = {
    bookDossier: { findUnique: jest.fn().mockResolvedValue(DOSSIER) },
    translationRunLanguage: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const support = { pauseStale: jest.fn().mockResolvedValue({ kind: 'continue' }) };
  const steps = new ContextRunStepsService(
    db as unknown as PrismaService,
    {} as LlmTaskService,
    {} as DossierDemandService,
    support as unknown as RunStepSupportService,
  );
  return { steps, db, tx, support };
}

beforeEach(() => {
  demandMock.mockReset();
  fingerprintMock.mockReset().mockResolvedValue('fp1');
});

describe('ContextRunStepsService: готовый контекст', () => {
  it('первый язык привязывает досье запуска и свой глоссарий одной транзакцией', async () => {
    const { steps, db, tx } = setup();
    demandMock.mockResolvedValue({ kind: 'ready', dossier: DOSSIER, glossary: GLOSSARY });
    await expect(steps.awaitContext(lang())).resolves.toEqual({ kind: 'continue' });
    expect(demandMock).toHaveBeenCalledTimes(1);
    expect(demandMock).toHaveBeenCalledWith(
      {},
      {},
      {
        versionId: 'v1',
        language: 'es',
        operationId: 'op1',
        waitingFor: null,
        dossier: null,
        translationRunId: 'r1',
        rebuildStale: true,
        onLimit: expect.any(Function),
      },
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), RUN_TX_OPTIONS);
    expect(tx.translationRun.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.translationRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', dossierId: null },
      data: { dossierId: 'dos1', dossierFingerprint: 'fp1' },
    });
    expect(tx.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(tx.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { glossaryId: 'g1', waitingFor: null, ...CLEAR_STOP },
    });
  });

  it('досье привязал другой язык (другое поколение) - глоссарий этого языка не пишется', async () => {
    const { steps, tx } = setup('dos-other');
    demandMock.mockResolvedValue({ kind: 'ready', dossier: DOSSIER, glossary: GLOSSARY });
    await expect(steps.awaitContext(lang())).resolves.toEqual({ kind: 'continue' });
    expect(tx.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('досье уже привязано - не перестраивается и не перепривязывается', async () => {
    const { steps, tx } = setup();
    demandMock.mockResolvedValue({ kind: 'ready', dossier: DOSSIER, glossary: GLOSSARY });
    await steps.awaitContext(lang({}, { dossierId: 'dos1' }));
    expect(demandMock).toHaveBeenCalledTimes(1);
    expect(demandMock).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ rebuildStale: false }),
    );
    expect(fingerprintMock).not.toHaveBeenCalled();
    expect(tx.translationRun.updateMany).not.toHaveBeenCalled();
    expect(tx.translationRunLanguage.update).toHaveBeenCalledTimes(1);
  });

  it('досье другой версии исходника - пауза устаревшего исходника, без привязки', async () => {
    const { steps, db, support } = setup();
    demandMock.mockResolvedValue({
      kind: 'ready',
      dossier: { ...DOSSIER, sourceVersionId: 'v-other' },
      glossary: GLOSSARY,
    });
    await steps.awaitContext(lang());
    expect(support.pauseStale).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('исходник правили, пока строилось досье - шаг повторится, без привязки', async () => {
    const { steps, db, support } = setup();
    fingerprintMock.mockResolvedValue('fp-new');
    demandMock.mockResolvedValue({ kind: 'ready', dossier: DOSSIER, glossary: GLOSSARY });
    await expect(steps.awaitContext(lang())).resolves.toEqual({ kind: 'continue' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(support.pauseStale).not.toHaveBeenCalled();
  });
});

describe('ContextRunStepsService: ожидание и отказы', () => {
  it('ожидание - операция, которую ждёт язык, пишется только при смене', async () => {
    const { steps, db } = setup();
    demandMock.mockResolvedValue({ kind: 'wait', waitingFor: 'op-dossier', reason: 'WAIT' });
    await expect(steps.awaitContext(lang())).resolves.toEqual({ kind: 'wait', reason: 'WAIT' });
    expect(db.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { waitingFor: 'op-dossier' },
    });
  });

  it('ожидание той же операции - без записи', async () => {
    const { steps, db } = setup();
    demandMock.mockResolvedValue({ kind: 'wait', waitingFor: 'op-dossier', reason: 'WAIT' });
    await steps.awaitContext(lang({ waitingFor: 'op-dossier' }));
    expect(db.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('лимит до трат: onLimit пишет код и сумму той же транзакцией', async () => {
    const { steps } = setup();
    const limitTx = { translationRunLanguage: { update: jest.fn().mockResolvedValue({}) } };
    demandMock.mockImplementation(
      async (
        _d: unknown,
        _t: unknown,
        input: { onLimit: (tx: unknown, usd: unknown) => unknown },
      ) => {
        await input.onLimit(limitTx, '1.5');
        return { kind: 'stopped', reason: 'LIMIT_REACHED', blockedBy: null };
      },
    );
    await steps.awaitContext(lang());
    expect(limitTx.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(limitTx.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { ...CLEAR_STOP, reason: DOSSIER_LIMIT_TOO_LOW, reasonUsd: '1.5' },
    });
  });

  it('остановка LIMIT_REACHED без операции досье - код и лимит, записанные до трат, не затираются', async () => {
    const { steps, db } = setup();
    demandMock.mockResolvedValue({ kind: 'stopped', reason: 'LIMIT_REACHED', blockedBy: null });
    await expect(steps.awaitContext(lang())).resolves.toEqual({ kind: 'continue' });
    expect(db.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('досье остановлено своей операцией - причина и операция досье у языка', async () => {
    const { steps, db } = setup();
    demandMock.mockResolvedValue({ kind: 'stopped', reason: 'STEP_FAILED', blockedBy: 'op-d' });
    await steps.awaitContext(lang());
    expect(db.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { reason: 'STEP_FAILED', blockedByOperationId: 'op-d' },
    });
  });

  it('строку меняли одновременно - «повторить позже», без записи', async () => {
    const { steps, db } = setup();
    demandMock.mockResolvedValue({ kind: 'retry', code: 'BUSY' });
    await expect(steps.awaitContext(lang())).resolves.toEqual({ kind: 'wait', reason: 'BUSY' });
    expect(db.translationRunLanguage.update).not.toHaveBeenCalled();
  });

  it('отказ контекста - код у языка и отказ шага', async () => {
    const { steps, db } = setup();
    demandMock.mockResolvedValue({ kind: 'failed', code: 'DOSSIER_FAILED' });
    await expect(steps.awaitContext(lang())).resolves.toEqual({
      kind: 'fail',
      reason: 'DOSSIER_FAILED',
    });
    expect(db.translationRunLanguage.update).toHaveBeenCalledTimes(1);
    expect(db.translationRunLanguage.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { reason: 'DOSSIER_FAILED' },
    });
  });
});
