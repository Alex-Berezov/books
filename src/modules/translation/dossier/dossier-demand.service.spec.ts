import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { chapterPages } from '../chapter-pages';
import { sourceFingerprint } from '../source-fingerprint';
import { TranslationSourceService } from '../translation-source.service';
import { DossierDemandService } from './dossier-demand.service';

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
  const service = new DossierDemandService(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
    budget as unknown as LlmBudgetService,
    tasks as unknown as LlmTaskService,
    sources as unknown as TranslationSourceService,
  );
  return { service, prisma, llm, tasks };
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
