import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { sourceFingerprint } from '../source-fingerprint';
import { DossierDemandService } from './dossier-demand.service';
import { DossierService } from './dossier.service';

jest.mock('../source-fingerprint', () => ({
  ...jest.requireActual<Record<string, unknown>>('../source-fingerprint'),
  sourceFingerprint: jest.fn(),
}));

/**
 * Досье для админки на подменённых базе и спросе: статус версии перевода берёт досье её запуска
 * (Р18), кнопка «построить» отказывает свежему и версии перевода, глоссарий без строки - 404.
 */

const fingerprintMock = sourceFingerprint as jest.Mock;

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
    createdAt: new Date('2026-10-30T00:00:00Z'),
    updatedAt: new Date('2026-10-30T00:00:00Z'),
    ...patch,
  };
}

function setup() {
  const db = {
    bookGlossary: { findUnique: jest.fn() },
    bookDossierPart: { count: jest.fn().mockResolvedValue(3) },
    bookDossierGroup: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  const llm = { assertEnabled: jest.fn() };
  const demand = {
    dossierSourceOf: jest.fn().mockResolvedValue({ bookId: 'b1', sourceVersionId: 'v1' }),
    latestDossier: jest.fn(),
    runContextOf: jest.fn().mockResolvedValue(null),
    operationOf: jest.fn().mockResolvedValue(null),
    demandDossier: jest.fn(),
  };
  const service = new DossierService(
    db as unknown as PrismaService,
    llm as unknown as LlmService,
    demand as unknown as DossierDemandService,
  );
  return { service, db, llm, demand };
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

beforeEach(() => {
  jest.clearAllMocks();
  fingerprintMock.mockResolvedValue('fp1');
});

describe('DossierService.status', () => {
  it('a manual version reports the freshness of its source dossier by fingerprint', async () => {
    const { service, demand, db } = setup();
    demand.latestDossier.mockResolvedValue(dossierRow({ fingerprint: 'old' }));

    const status = await service.status('v1');

    expect(status).toMatchObject({ sourceVersionId: 'v1', partsDone: 3, fresh: false });
    expect(demand.dossierSourceOf).toHaveBeenCalledTimes(1);
    expect(demand.dossierSourceOf).toHaveBeenCalledWith('v1');
    expect(fingerprintMock).toHaveBeenCalledTimes(1);
    expect(fingerprintMock).toHaveBeenCalledWith(db, 'v1');
    expect(demand.latestDossier).toHaveBeenCalledTimes(1);
    expect(demand.latestDossier).toHaveBeenCalledWith('v1');
    expect(db.bookDossierPart.count).toHaveBeenCalledTimes(1);
    expect(db.bookDossierPart.count).toHaveBeenCalledWith({ where: { dossierId: 'dos1' } });
  });

  it('a matching fingerprint is fresh; groups are counted done of all, operations in order', async () => {
    const { service, demand, db } = setup();
    demand.latestDossier.mockResolvedValue(
      dossierRow({ status: 'building', operationId: 'op2', previousOperationId: 'op1' }),
    );
    db.bookDossierGroup.groupBy.mockResolvedValue([
      { done: true, _count: { _all: 2 } },
      { done: false, _count: { _all: 3 } },
    ]);

    const status = await service.status('v1');

    expect(status).toMatchObject({ fresh: true, groupsDone: 2, groupsTotal: 5 });
    expect(db.bookDossierGroup.groupBy).toHaveBeenCalledTimes(1);
    expect(demand.operationOf).toHaveBeenCalledTimes(2);
    expect(demand.operationOf).toHaveBeenNthCalledWith(1, 'op2');
    expect(demand.operationOf).toHaveBeenNthCalledWith(2, 'op1');
  });

  it('a translated version takes the dossier of its run and never calls it stale', async () => {
    const { service, demand } = setup();
    demand.runContextOf.mockResolvedValue({
      sourceVersionId: 'src9',
      dossier: dossierRow({ fingerprint: 'old' }),
      glossaryId: null,
      status: 'done',
    });

    const status = await service.status('t1');

    expect(status).toMatchObject({ sourceVersionId: 'src9', fresh: true });
    expect(demand.latestDossier).not.toHaveBeenCalled();
    expect(fingerprintMock).not.toHaveBeenCalled();
  });

  it('a version without a dossier counts no parts', async () => {
    const { service, demand, db } = setup();
    demand.latestDossier.mockResolvedValue(null);

    await expect(service.status('v1')).resolves.toMatchObject({ partsDone: 0 });
    expect(db.bookDossierPart.count).not.toHaveBeenCalled();
  });
});

describe('DossierService.glossary', () => {
  it('a pair without a row is 404', async () => {
    const { service, db, demand } = setup();
    db.bookGlossary.findUnique.mockResolvedValue(null);

    await expect(service.glossary('dos1', 'es')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.bookGlossary.findUnique).toHaveBeenCalledTimes(1);
    expect(db.bookGlossary.findUnique).toHaveBeenCalledWith({
      where: { dossierId_language: { dossierId: 'dos1', language: 'es' } },
    });
    expect(demand.operationOf).not.toHaveBeenCalled();
  });

  it('a row reads its builder and the previous builder, in that order', async () => {
    const { service, db, demand } = setup();
    db.bookGlossary.findUnique.mockResolvedValue({
      id: 'gl1',
      dossierId: 'dos1',
      language: 'es',
      status: 'building',
      data: null,
      history: null,
      model: null,
      operationId: 'op2',
      previousOperationId: 'op1',
      updatedAt: new Date('2026-10-30T00:00:00Z'),
    });

    await expect(service.glossary('dos1', 'es')).resolves.toMatchObject({
      id: 'gl1',
      status: 'building',
    });
    expect(demand.operationOf).toHaveBeenCalledTimes(2);
    expect(demand.operationOf).toHaveBeenNthCalledWith(1, 'op2');
    expect(demand.operationOf).toHaveBeenNthCalledWith(2, 'op1');
  });
});

describe('DossierService.build', () => {
  it('a version made by a run refuses DOSSIER_OF_RUN before any spending check', async () => {
    const { service, demand, llm } = setup();
    demand.runContextOf.mockResolvedValue({
      sourceVersionId: 'src9',
      dossier: null,
      glossaryId: null,
      status: 'done',
    });

    expect(await codeOf(service.build('t1', undefined, 'u1'))).toBe('DOSSIER_OF_RUN');
    expect(llm.assertEnabled).not.toHaveBeenCalled();
    expect(demand.demandDossier).not.toHaveBeenCalled();
  });

  it('a fresh ready dossier refuses DOSSIER_FRESH', async () => {
    const { service, demand } = setup();
    demand.demandDossier.mockResolvedValue({ status: 'ready', row: dossierRow(), fresh: true });

    expect(await codeOf(service.build('v1', undefined, 'u1'))).toBe('DOSSIER_FRESH');
    expect(demand.demandDossier).toHaveBeenCalledTimes(1);
  });

  it('disabled LLM refuses before the dossier is demanded', async () => {
    const { service, demand, llm } = setup();
    llm.assertEnabled.mockImplementation(() => {
      throw new HttpException({ code: 'LLM_DISABLED' }, 409);
    });

    expect(await codeOf(service.build('v1', undefined, 'u1'))).toBe('LLM_DISABLED');
    expect(demand.demandDossier).not.toHaveBeenCalled();
  });

  it.each(['failed', 'paused'])(
    'a %s demand answers with the status, not a refusal',
    async (st) => {
      const { service, demand } = setup();
      const status = st === 'failed' ? 'failed' : 'building';
      const row = dossierRow({ status });
      demand.demandDossier.mockResolvedValue({ status: st, row, fresh: true });
      demand.latestDossier.mockResolvedValue(row);

      await expect(service.build('v1', undefined, 'u1')).resolves.toMatchObject({
        sourceVersionId: 'v1',
        status,
        id: 'dos1',
      });
    },
  );

  it('a started build rebuilds stale with the editor limit and answers with the status', async () => {
    const { service, demand } = setup();
    const row = dossierRow({ status: 'building' });
    demand.demandDossier.mockResolvedValue({ status: 'wait', row, fresh: true });
    demand.latestDossier.mockResolvedValue(row);
    const limit = new Prisma.Decimal('2.5');

    const status = await service.build('v1', limit, 'u1');

    expect(demand.demandDossier).toHaveBeenCalledTimes(1);
    expect(demand.demandDossier).toHaveBeenCalledWith('v1', {
      rebuildStale: true,
      limitUsd: limit,
      createdById: 'u1',
    });
    expect(status).toMatchObject({ sourceVersionId: 'v1' });
  });
});
