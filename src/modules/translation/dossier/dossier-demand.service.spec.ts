import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { chapterPages } from '../chapter-pages';
import { sourceFingerprint } from '../source-fingerprint';
import { TranslationSourceService } from '../translation-source.service';
import { DossierBuilderService } from './dossier-builder.service';
import { DossierDemandService } from './dossier-demand.service';
import { DossierEstimatesService } from './dossier-estimates.service';

jest.mock('../source-fingerprint', () => ({
  ...jest.requireActual<Record<string, unknown>>('../source-fingerprint'),
  sourceFingerprint: jest.fn(),
}));
jest.mock('../chapter-pages', () => ({
  ...jest.requireActual<Record<string, unknown>>('../chapter-pages'),
  chapterPages: jest.fn(),
}));

/**
 * Спрос на досье и глоссарий на подменённых базе, модели и задачах: готовое свежее не строится
 * заново, ждущий на упавшей строке своего текста встаёт на паузу один раз, гонка вставки
 * повторяется три круга, глоссарий без готового досье и контекст недописанного языка - отказ,
 * оценка по кнопке показывает устаревшее досье строкой.
 */

const fingerprintMock = sourceFingerprint as jest.Mock;
const pagesMock = chapterPages as jest.Mock;
const D = (v: string) => new Prisma.Decimal(v);

function dossierRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'dos1',
    bookId: 'b1',
    sourceVersionId: 'v1',
    generation: 1,
    fingerprint: 'fp1',
    status: 'ready',
    operationId: null,
    previousOperationId: null,
    takeovers: 0,
    failedReason: null,
    model: null,
    data: null,
    ...patch,
  };
}

function glossaryRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'gl1',
    dossierId: 'dos1',
    language: 'es',
    status: 'building',
    operationId: 'opb',
    previousOperationId: null,
    takeovers: 0,
    ...patch,
  };
}

function setup() {
  const prisma = {
    bookDossier: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    bookGlossary: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    llmOperation: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    translationRunLanguage: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const call = {
    maxTokens: 1000,
    enabled: true,
    contextLength: null,
    estimate: jest.fn().mockReturnValue(D('0.01')),
  };
  const llm = {
    assertEnabled: jest.fn(),
    getStageSetting: jest.fn().mockResolvedValue({ maxTokens: 1000, model: 'm1' }),
    stageCallEstimator: jest.fn().mockResolvedValue(call),
    operationData: jest.fn().mockResolvedValue({ kind: 'dossier' }),
  };
  const budget = { ceilingReached: jest.fn().mockResolvedValue(false) };
  const tasks = { enqueue: jest.fn(), pauseOperation: jest.fn() };
  const sources = {
    forVersion: jest.fn().mockResolvedValue({ bookId: 'b1', dossierSourceVersionId: 'v1' }),
  };
  const estimates = new DossierEstimatesService(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
  );
  const service = new DossierDemandService(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
    sources as unknown as TranslationSourceService,
    estimates,
    new DossierBuilderService(
      prisma as unknown as PrismaService,
      llm as unknown as LlmService,
      budget as unknown as LlmBudgetService,
      tasks as unknown as LlmTaskService,
      estimates,
    ),
  );
  return { service, prisma, llm, tasks, budget };
}

const codeOf = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return (e.getResponse() as { code?: string }).code;
    throw e;
  }
  throw new Error('no refusal');
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.0.0',
  });

beforeEach(() => {
  jest.clearAllMocks();
  fingerprintMock.mockResolvedValue('fp1');
  pagesMock.mockImplementation(function* () {
    yield [{ number: 1, title: 'One', content: 'Some chapter text.' }];
  });
});

describe('DossierDemandService.demandDossier', () => {
  it('a fresh ready dossier is returned as is, even from the build button: nothing is started', async () => {
    const { service, prisma, llm } = setup();
    const row = dossierRow();
    prisma.bookDossier.findFirst.mockResolvedValue(row);

    const demand = await service.demandDossier('v1', { rebuildStale: true });

    expect(demand).toEqual({ status: 'ready', row, fresh: true });
    expect(llm.operationData).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a waiter on the failed row of its own text pauses STEP_FAILED once and gets failed', async () => {
    const { service, prisma, tasks } = setup();
    const row = dossierRow({ status: 'failed' });
    prisma.bookDossier.findFirst.mockResolvedValue(row);

    const demand = await service.demandDossier('v1', {
      waiter: { operationId: 'w1', waitingFor: 'dos1' },
    });

    expect(demand).toEqual({ status: 'failed', row, fresh: true });
    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(tasks.pauseOperation).toHaveBeenCalledWith('w1', 'STEP_FAILED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a waiter on its failed row after the text was edited builds a new generation, not STEP_FAILED', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findFirst.mockResolvedValue(
      dossierRow({ status: 'failed', fingerprint: 'old' }),
    );
    const built = dossierRow({ id: 'dos2', generation: 2, status: 'building' });
    const tx = {
      llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op2' }) },
      bookDossier: { create: jest.fn().mockResolvedValue(built) },
    };
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    prisma.llmOperation.findUnique.mockResolvedValue({
      limitUsd: D('10'),
      spentUsd: D('0'),
      reservedUsd: D('0'),
    });

    const demand = await service.demandDossier('v1', {
      waiter: { operationId: 'w1', waitingFor: 'dos1' },
    });

    expect(demand).toEqual({ status: 'wait', row: built, fresh: true });
    expect(tasks.pauseOperation).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.bookDossier.create).toHaveBeenCalledTimes(1);
    expect(tx.bookDossier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookId: 'b1',
        sourceVersionId: 'v1',
        generation: 2,
        fingerprint: 'fp1',
        operationId: 'op2',
      }) as unknown,
    });
    expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op2', payload: { dossierId: 'dos2' } }),
      tx,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 10_000,
      maxWait: 5_000,
    });
  });

  it('the button refuses LLM_CEILING_REACHED at the spending ceiling and starts nothing', async () => {
    const { service, prisma, budget } = setup();
    prisma.bookDossier.findFirst.mockResolvedValue(null);
    budget.ceilingReached.mockResolvedValue(true);

    expect(await codeOf(service.demandDossier('v1'))).toBe('LLM_CEILING_REACHED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a waiter is not stopped by the spending ceiling: it starts the build', async () => {
    const { service, prisma, budget } = setup();
    prisma.bookDossier.findFirst.mockResolvedValue(null);
    budget.ceilingReached.mockResolvedValue(true);
    prisma.llmOperation.findUnique.mockResolvedValue({
      limitUsd: D('10'),
      spentUsd: D('0'),
      reservedUsd: D('0'),
    });
    const built = dossierRow({ status: 'building' });
    const tx = {
      llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op2' }) },
      bookDossier: { create: jest.fn().mockResolvedValue(built) },
    };
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    const demand = await service.demandDossier('v1', { waiter: { operationId: 'w1' } });

    expect(demand).toEqual({ status: 'wait', row: built, fresh: true });
    expect(budget.ceilingReached).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('three lost insert races in a row are DOSSIER_BUSY, not a fourth try', async () => {
    const { service, prisma } = setup();
    prisma.bookDossier.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValue(uniqueViolation());

    expect(await codeOf(service.demandDossier('v1'))).toBe('DOSSIER_BUSY');
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});

describe('DossierDemandService.demandGlossary', () => {
  it('a dossier that is not ready refuses DOSSIER_NOT_READY before any glossary row is read', async () => {
    const { service, prisma } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(dossierRow({ status: 'building' }));

    expect(await codeOf(service.demandGlossary('dos1', 'es'))).toBe('DOSSIER_NOT_READY');
    expect(prisma.bookGlossary.findUnique).not.toHaveBeenCalled();
  });
});

describe('DossierDemandService.demandGlossary, building', () => {
  const ready = () => dossierRow({ status: 'ready' });
  const BUILD_TX = { timeout: 10_000, maxWait: 5_000 };

  function txFor(glossary: unknown, taken = 1) {
    return {
      llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op2' }) },
      bookGlossary: {
        create: jest.fn().mockResolvedValue(glossary),
        updateMany: jest.fn().mockResolvedValue({ count: taken }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(glossaryRow({ operationId: 'op2' })),
      },
    };
  }

  it('no row yet: the row, its operation and first task are created in one transaction', async () => {
    const { service, prisma, llm, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(null);
    const built = glossaryRow({ operationId: 'op2' });
    const tx = txFor(built);
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    const demand = await service.demandGlossary('dos1', 'es');

    expect(demand).toEqual({ status: 'wait', row: built });
    expect(llm.operationData).toHaveBeenCalledTimes(1);
    // Лимит без лимита редактора - оценка × 1,5 (`DOSSIER_LIMIT_FACTOR`).
    expect(llm.operationData).toHaveBeenCalledWith({
      kind: 'dossier',
      bookVersionId: 'v1',
      limitUsd: D('0.015'),
      createdById: null,
      translationRunId: null,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), BUILD_TX);
    expect(tx.bookGlossary.create).toHaveBeenCalledTimes(1);
    expect(tx.bookGlossary.create).toHaveBeenCalledWith({
      data: { dossierId: 'dos1', language: 'es', operationId: 'op2' },
    });
    expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op2', payload: { glossaryId: 'gl1' } }),
      tx,
    );
  });

  it('a failed row is reopened by a condition on its status, not recreated', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(glossaryRow({ status: 'failed' }));
    const tx = txFor(null);
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    const demand = await service.demandGlossary('dos1', 'es');

    expect(demand).toEqual({ status: 'wait', row: glossaryRow({ operationId: 'op2' }) });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), BUILD_TX);
    expect(tx.bookGlossary.create).not.toHaveBeenCalled();
    expect(tx.bookGlossary.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.bookGlossary.updateMany).toHaveBeenCalledWith({
      where: { id: 'gl1', status: 'failed' },
      data: { status: 'building', operationId: 'op2', previousOperationId: null, takeovers: 0 },
    });
    expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op2', payload: { glossaryId: 'gl1' } }),
      tx,
    );
  });

  it('a lost reopen race enqueues nothing and three lost rounds are GLOSSARY_BUSY', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(glossaryRow({ status: 'failed' }));
    const tx = txFor(null, 0);
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    expect(await codeOf(service.demandGlossary('dos1', 'es'))).toBe('GLOSSARY_BUSY');
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(tasks.enqueue).not.toHaveBeenCalled();
  });

  it('a lost insert race (P2002) reads the row again instead of failing', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    const winner = glossaryRow({ operationId: 'opw' });
    prisma.bookGlossary.findUnique.mockResolvedValueOnce(null).mockResolvedValue(winner);
    prisma.$transaction.mockRejectedValue(uniqueViolation());
    prisma.llmOperation.findUnique.mockResolvedValue({ id: 'opw', status: 'active' });

    const demand = await service.demandGlossary('dos1', 'es');

    expect(demand).toEqual({ status: 'wait', row: winner });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).not.toHaveBeenCalled();
  });

  it('a waiter whose limit does not fit the new glossary pauses LIMIT_REACHED and starts nothing', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(null);
    prisma.llmOperation.findUnique.mockResolvedValue({
      limitUsd: D('0.001'),
      spentUsd: D('0'),
      reservedUsd: D('0'),
    });

    const demand = await service.demandGlossary('dos1', 'es', { waiter: { operationId: 'w1' } });

    expect(demand).toEqual({
      status: 'paused',
      row: null,
      reason: 'LIMIT_REACHED',
      builderOperationId: null,
    });
    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(tasks.pauseOperation).toHaveBeenCalledWith('w1', 'LIMIT_REACHED', undefined);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the minimal waiter limit is written by onLimit inside the pause transaction', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(null);
    prisma.llmOperation.findUnique.mockResolvedValue({
      limitUsd: D('0.001'),
      spentUsd: D('0.002'),
      reservedUsd: D('0'),
    });
    const pauseTx = {};
    tasks.pauseOperation.mockImplementation(
      async (_id: string, _reason: string, inTx?: (t: unknown) => Promise<void>) => {
        await inTx?.(pauseTx);
      },
    );
    const onLimit = jest.fn();

    await service.demandGlossary('dos1', 'es', { waiter: { operationId: 'w1', onLimit } });

    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledTimes(1);
    // Потрачено 0,002 + лимит глоссария 0,015 (оценка × 1,5).
    expect(onLimit).toHaveBeenCalledWith(pauseTx, D('0.017'));
  });

  it('a builder that failed is taken over once by a new operation', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(glossaryRow());
    prisma.llmOperation.findUnique.mockResolvedValue({ id: 'opb', status: 'failed' });
    const tx = txFor(null);
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    const demand = await service.demandGlossary('dos1', 'es');

    expect(demand).toMatchObject({
      status: 'wait',
      row: { id: 'gl1', operationId: 'op2', previousOperationId: 'opb', takeovers: 1 },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), BUILD_TX);
    expect(tx.bookGlossary.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.bookGlossary.updateMany).toHaveBeenCalledWith({
      where: { id: 'gl1', status: 'building', operationId: 'opb', takeovers: 0 },
      data: { operationId: 'op2', previousOperationId: 'opb', takeovers: 1 },
    });
    expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op2', payload: { glossaryId: 'gl1' } }),
      tx,
    );
  });

  it('the button does not take over at the spending ceiling: LLM_CEILING_REACHED', async () => {
    const { service, prisma, budget } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(glossaryRow());
    prisma.llmOperation.findUnique.mockResolvedValue({ id: 'opb', status: 'failed' });
    budget.ceilingReached.mockResolvedValue(true);

    expect(await codeOf(service.demandGlossary('dos1', 'es'))).toBe('LLM_CEILING_REACHED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a takeover lost to another waiter enqueues nothing and reads the row again', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    const taken = glossaryRow({ operationId: 'opx', previousOperationId: 'opb', takeovers: 1 });
    prisma.bookGlossary.findUnique.mockResolvedValueOnce(glossaryRow()).mockResolvedValue(taken);
    prisma.llmOperation.findUnique
      .mockResolvedValueOnce({ id: 'opb', status: 'failed' })
      .mockResolvedValue({ id: 'opx', status: 'active' });
    const tx = txFor(null, 0);
    prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

    const demand = await service.demandGlossary('dos1', 'es');

    expect(demand).toEqual({ status: 'wait', row: taken });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).not.toHaveBeenCalled();
  });

  it('a row already taken over once is not taken again: the waiter pauses STEP_FAILED', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(glossaryRow({ takeovers: 1 }));
    prisma.llmOperation.findUnique.mockResolvedValue({ id: 'opb', status: 'failed' });
    const closeTx = { bookGlossary: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    tasks.pauseOperation.mockImplementation(
      async (_id: string, _reason: string, inTx?: (t: unknown) => Promise<void>) => {
        await inTx?.(closeTx);
      },
    );

    const demand = await service.demandGlossary('dos1', 'es', {
      waiter: { operationId: 'w1', waitingFor: 'gl1' },
    });

    expect(demand).toMatchObject({ status: 'failed', row: { id: 'gl1', status: 'failed' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(tasks.pauseOperation).toHaveBeenCalledWith('w1', 'STEP_FAILED', expect.any(Function));
    expect(closeTx.bookGlossary.updateMany).toHaveBeenCalledTimes(1);
    expect(closeTx.bookGlossary.updateMany).toHaveBeenCalledWith({
      where: { id: 'gl1', status: 'building', operationId: 'opb' },
      data: { status: 'failed' },
    });
  });

  it('a paused builder pauses the waiter DOSSIER_PAUSED and names its operation', async () => {
    const { service, prisma, tasks } = setup();
    prisma.bookDossier.findUnique.mockResolvedValue(ready());
    prisma.bookGlossary.findUnique.mockResolvedValue(glossaryRow());
    prisma.llmOperation.findUnique.mockResolvedValue({ id: 'opb', status: 'paused' });

    const demand = await service.demandGlossary('dos1', 'es', { waiter: { operationId: 'w1' } });

    expect(demand).toMatchObject({
      status: 'paused',
      reason: 'DOSSIER_PAUSED',
      builderOperationId: 'opb',
    });
    expect(tasks.pauseOperation).toHaveBeenCalledTimes(1);
    expect(tasks.pauseOperation).toHaveBeenCalledWith('w1', 'DOSSIER_PAUSED');
  });
});

describe('DossierDemandService.finishedRunContextOf', () => {
  const linked = (status: string) => ({
    glossaryId: 'g1',
    status,
    run: { bookVersionId: 'v1', dossier: dossierRow() },
  });

  it.each(['pending', 'running'])(
    'a run language still %s refuses RUN_LANGUAGE_UNFINISHED',
    async (status) => {
      const { service, prisma } = setup();
      prisma.translationRunLanguage.findUnique.mockResolvedValue(linked(status));

      expect(await codeOf(service.finishedRunContextOf('t1'))).toBe('RUN_LANGUAGE_UNFINISHED');
      expect(prisma.translationRunLanguage.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.translationRunLanguage.findUnique).toHaveBeenCalledWith({
        where: { bookVersionId: 't1' },
        select: {
          glossaryId: true,
          status: true,
          run: { select: { bookVersionId: true, dossier: true } },
        },
      });
    },
  );

  it.each(['done', 'failed', 'cancelled'])(
    'a %s run language gives the dossier and glossary of its run',
    async (status) => {
      const { service, prisma } = setup();
      prisma.translationRunLanguage.findUnique.mockResolvedValue(linked(status));

      await expect(service.finishedRunContextOf('t1')).resolves.toEqual({
        sourceVersionId: 'v1',
        dossier: dossierRow(),
        glossaryId: 'g1',
        status,
      });
    },
  );

  it('a manual version has no run context', async () => {
    const { service, prisma } = setup();
    prisma.translationRunLanguage.findUnique.mockResolvedValue(null);

    await expect(service.finishedRunContextOf('t1')).resolves.toBeNull();
  });
});

describe('DossierDemandService.contextEstimates', () => {
  it('a stale ready dossier is a dossier line when the waiter rebuilds stale, and none otherwise', async () => {
    const { service, prisma } = setup();
    prisma.bookDossier.findFirst.mockResolvedValue(dossierRow({ fingerprint: 'old' }));

    const rebuilt = await service.contextEstimates('v1', ['es'], { rebuildStale: true });
    expect(rebuilt.dossier).toMatchObject({ sourceVersionId: 'v1', chapters: 1, parts: 1 });
    expect(rebuilt.glossaries.get('es')).toMatchObject({ upperBound: true });

    const kept = await service.contextEstimates('v1', ['es']);
    expect(kept.dossier).toBeNull();
    expect(kept.glossaries.get('es')).toMatchObject({ upperBound: false });
  });
});
