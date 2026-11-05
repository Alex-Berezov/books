import { HttpException, NotFoundException } from '@nestjs/common';
import { BookDossier, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { readStoredAnalysis } from '../../book-analysis/book-analysis-data';
import { DossierService } from '../dossier/dossier.service';
import { ContentDraftService } from './content-draft.service';

/**
 * Сервис заготовки Analysis (F05-11) на подменённой базе: отказ до операции по потолку, вторая
 * строящаяся - 409 по уникальному индексу, «не нужна» - отмена операции у строящейся и только
 * статус у прочих; дренаж снятых видов Summary (F06-3, А1).
 */

const op = {
  id: 'op1',
  kind: 'draft',
  status: 'active',
  pauseReason: null,
  bookVersionId: 'v1',
  limitUsd: new Prisma.Decimal(1),
  reservedUsd: new Prisma.Decimal(0),
  spentUsd: new Prisma.Decimal(0),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const draft = (patch: Record<string, unknown> = {}) => ({
  id: 'd1',
  bookVersionId: 'v1',
  kind: 'analysis',
  status: 'building',
  language: 'en',
  operationId: 'op1',
  data: null,
  model: null,
  failedReason: null,
  dossierId: null,
  glossaryId: null,
  waitingFor: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  operation: op,
  ...patch,
});

function setup() {
  const tx = {
    contentDraft: { updateMany: jest.fn(), create: jest.fn().mockResolvedValue(draft()) },
    llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op1' }) },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ language: 'en', title: 'Book' }) },
    bookGlossary: { findUnique: jest.fn().mockResolvedValue(null) },
    contentDraft: {
      findUnique: jest.fn().mockResolvedValue(draft()),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
  };
  const llm = {
    assertEnabled: jest.fn(),
    stageCallEstimator: jest.fn().mockResolvedValue({
      enabled: true,
      maxTokens: 100,
      contextLength: null,
      estimate: () => new Prisma.Decimal('0.01'),
    }),
    operationData: jest.fn().mockResolvedValue({ kind: 'draft' }),
  };
  const budget = { ceilingReached: jest.fn().mockResolvedValue(false) };
  const tasks = {
    enqueue: jest.fn(),
    cancelOperation: jest.fn(
      async (_id: string, fn: (t: typeof tx) => Promise<void>) => (await fn(tx), true),
    ),
  };
  const service = new ContentDraftService(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
    budget as unknown as LlmBudgetService,
    tasks as unknown as LlmTaskService,
    {} as DossierService,
    {} as DossierDemandService,
  );
  return { service, prisma, llm, budget, tasks, tx };
}

/** Заготовка с оценкой анализа без текста книги: одна глава, досье готово, анализа нет. */
function setupDraft() {
  const r = setup();
  jest
    .spyOn(r.service, 'versionChapters')
    .mockResolvedValue([{ number: 1, title: 'C1', content: '<p>Text.</p>' }]);
  jest.spyOn(r.service, 'draftContext').mockResolvedValue({
    run: null,
    dossier: { id: 'dos1', data: {} } as unknown as BookDossier,
    glossaryData: null,
    dossierLine: null,
    glossaryLine: null,
  });
  jest
    .spyOn(r.service, 'storedAnalysis')
    .mockResolvedValue({ stored: readStoredAnalysis({}), updatedAt: null });
  return r;
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

describe('ContentDraftService (F05-11)', () => {
  it('ceiling reached - 409 before any operation or draft', async () => {
    const { service, budget, tx } = setupDraft();
    budget.ceilingReached.mockResolvedValue(true);
    await expect(codeOf(service.start('v1', 'analysis', undefined, 'u1'))).resolves.toBe(
      'LLM_CEILING_REACHED',
    );
    expect(tx.llmOperation.create).not.toHaveBeenCalled();
    expect(tx.contentDraft.create).not.toHaveBeenCalled();
  });

  it('start: the previous ready or failed is discarded, the draft and the task in one transaction', async () => {
    const { service, prisma, tx, tasks } = setupDraft();
    await service.start('v1', 'analysis', undefined, 'u1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'analysis', status: { in: ['ready', 'failed'] } },
      data: { status: 'discarded' },
    });
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'content_draft', payload: { draftId: 'd1' } }),
      tx,
    );
  });

  it('a second building draft - the unique index turns into 409 DRAFT_IN_PROGRESS', async () => {
    const { service, prisma } = setupDraft();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(codeOf(service.start('v1', 'analysis', undefined, 'u1'))).resolves.toBe(
      'DRAFT_IN_PROGRESS',
    );
  });

  it('discard: a building draft cancels its operation; a ready one only changes status', async () => {
    const building = setupDraft();
    await building.service.discard('d1');
    expect(building.tasks.cancelOperation).toHaveBeenCalledTimes(1);
    expect(building.tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'discarded' },
    });

    const ready = setupDraft();
    ready.prisma.contentDraft.findUnique.mockResolvedValue(draft({ status: 'ready' }));
    await ready.service.discard('d1');
    expect(ready.tasks.cancelOperation).not.toHaveBeenCalled();
    expect(ready.prisma.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: { not: 'discarded' } },
      data: { status: 'discarded' },
    });
  });

  it.each(['summary_write', 'summary_sections', 'summary_full', 'summary_brief'])(
    'a %s row is not a draft: get and discard answer 404 (F06 | F06-1, В2; F06 | F06-3, А2)',
    async (kind) => {
      const { service, prisma, tasks } = setupDraft();
      prisma.contentDraft.findUnique.mockResolvedValue(draft({ kind }));
      await expect(service.get('d1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.discard('d1')).rejects.toBeInstanceOf(NotFoundException);
      expect(tasks.cancelOperation).not.toHaveBeenCalled();
      expect(prisma.contentDraft.updateMany).not.toHaveBeenCalled();
    },
  );

  it('the draft answer never carries a summary_write row, whatever path read it (F06 | F06-1, В2)', async () => {
    const { service, prisma } = setupDraft();
    await service.latest('v1', 'analysis');
    // Первая защита - вид в запросе: строки хода выборка не находит.
    expect(prisma.contentDraft.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.contentDraft.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: 'analysis' }) }),
    );
    // Вторая - ответ заготовки: строка хода, пришедшая любым путём, наружу не уходит.
    prisma.contentDraft.findFirst.mockResolvedValue(draft({ kind: 'summary_write' }));
    await expect(service.latest('v1', 'analysis')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('latest: none - null; a ready draft carries its analysis', async () => {
    const { service, prisma } = setupDraft();
    await expect(service.latest('v1', 'analysis')).resolves.toEqual({ draft: null });
    prisma.contentDraft.findFirst.mockResolvedValue(
      draft({ status: 'ready', data: { analysis: { language: 'en' }, droppedQuotes: [] } }),
    );
    await expect(service.latest('v1', 'analysis')).resolves.toMatchObject({
      draft: { status: 'ready', analysis: { language: 'en' }, motifs: [], waitingFor: null },
    });
  });
});

describe('ContentDraftService retired summary drafts (F06-3, А1)', () => {
  const building = (id: string, operationId: string) => ({ id, operationId });

  it('drains building rows of the retired kinds by their operation, the Discard draft path', async () => {
    const { service, prisma, tasks, tx } = setupDraft();
    prisma.contentDraft.findMany.mockResolvedValueOnce([
      building('s1', 'op-s1'),
      building('f1', 'op-f1'),
    ]);
    await expect(service.drainRetiredSummaryDrafts()).resolves.toBe(2);
    expect(prisma.contentDraft.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.contentDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: { in: ['summary_sections', 'summary_full', 'summary_brief'] },
          status: 'building',
        },
        take: 100,
      }),
    );
    // Отмена - по операции строки, а не по виду задачи `content_draft` (он общий с analysis).
    expect(tasks.cancelOperation.mock.calls.map((c) => c[0])).toEqual(['op-s1', 'op-f1']);
    // По строке: одна запись в транзакции отмены и одна запасная - не больше.
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.contentDraft.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'building' },
      data: { status: 'discarded' },
    });
    expect(prisma.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'f1', status: { not: 'discarded' } },
      data: { status: 'discarded' },
    });
  });

  it('nothing to drain - nothing changes; a repeat is a no-op', async () => {
    const { service, prisma, tasks } = setupDraft();
    await expect(service.drainRetiredSummaryDrafts()).resolves.toBe(0);
    await expect(service.drainRetiredSummaryDrafts()).resolves.toBe(0);
    expect(tasks.cancelOperation).not.toHaveBeenCalled();
    expect(prisma.contentDraft.updateMany).not.toHaveBeenCalled();
  });

  it('a full batch reads the next one until a short batch', async () => {
    const { service, prisma } = setupDraft();
    const batch = Array.from({ length: 100 }, (_, i) => building(`d${i}`, `op${i}`));
    prisma.contentDraft.findMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([building('last', 'op-last')]);
    await expect(service.drainRetiredSummaryDrafts()).resolves.toBe(101);
    expect(prisma.contentDraft.findMany).toHaveBeenCalledTimes(2);
  });

  it('bootstrap drains the retired kinds: building rows are discarded at the start (А1)', async () => {
    const { service, prisma, tasks } = setupDraft();
    prisma.contentDraft.findMany.mockResolvedValueOnce([building('s1', 'op-s1')]);
    const drain = jest.spyOn(service, 'drainRetiredSummaryDrafts');
    await service.onApplicationBootstrap();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(tasks.cancelOperation).toHaveBeenCalledTimes(1);
    expect(tasks.cancelOperation).toHaveBeenCalledWith('op-s1', expect.any(Function));
  });

  it('a failed drain at bootstrap does not break the start', async () => {
    const { service, prisma } = setupDraft();
    prisma.contentDraft.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

describe('ContentDraftService.versionChapters (F05-Rb, Р2)', () => {
  /** Главы 1..total, у каждой 10 символов текста; выборка исполняет курсор, порядок и take. */
  const chaptersDb = (total: number) =>
    jest.fn((args: { where: { number: { gt?: number; gte?: number } }; take: number }) => {
      const after = args.where.number.gt ?? 0;
      return Promise.resolve(
        Array.from({ length: total }, (_, i) => ({
          number: i + 1,
          title: `C${i + 1}`,
          content: i === 4 ? '<p></p>' : '<p>0123456789</p>',
        }))
          .filter((c) => c.number > after)
          .slice(0, args.take),
      );
    });

  const withChapters = (total: number, maxInputChars: number | null) => {
    const { service, prisma, llm } = setup();
    const findMany = chaptersDb(total);
    Object.assign(prisma, { chapter: { findMany } });
    Object.assign(llm, {
      stageInputCeiling: jest.fn().mockResolvedValue({ maxInputChars, model: 'm' }),
    });
    return { service, findMany };
  };

  it('reads every chapter by pages past 2000 when the context is unknown, empty ones dropped', async () => {
    const { service, findMany } = withChapters(2_001, null);
    const chapters = await service.versionChapters('v1');
    expect(chapters).toHaveLength(2_000);
    expect(chapters?.[chapters.length - 1].number).toBe(2_001);
    expect(chapters?.some((c) => c.number === 5)).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(21);
  });

  it('stops at the input ceiling with null and does not read the rest of the book', async () => {
    const { service, findMany } = withChapters(2_001, 1_500);
    await expect(service.versionChapters('v1')).resolves.toBeNull();
    // 151 глава с текстом переходит 1500 символов на второй странице: третья не читается.
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('a text exactly at the ceiling still fits', async () => {
    const { service } = withChapters(11, 100);
    // 10 глав с текстом по 10 символов (пятая пустая) - ровно 100.
    await expect(service.versionChapters('v1')).resolves.toHaveLength(10);
  });
});

describe('ContentDraftService analysis estimate (F05-Rb, Р2)', () => {
  it('a text past the analysis model input is 409 DRAFT_TOO_LONG, not a sum for a part of the book', async () => {
    const { service } = setup();
    jest.spyOn(service, 'versionChapters').mockResolvedValue(null);
    await expect(codeOf(service.estimate('v1', 'analysis'))).resolves.toBe('DRAFT_TOO_LONG');
  });
});

describe('ContentDraftService.runKindOf (F07-1b, В6)', () => {
  it('the kind of a run row decides: summary_write and analysis_write come out, one select of the row', async () => {
    const { service, prisma } = setup();
    prisma.contentDraft.findUnique.mockResolvedValue({ kind: 'analysis_write' });
    await expect(service.runKindOf('d1')).resolves.toBe('analysis_write');
    prisma.contentDraft.findUnique.mockResolvedValue({ kind: 'summary_write' });
    await expect(service.runKindOf('d1')).resolves.toBe('summary_write');
    expect(prisma.contentDraft.findUnique).toHaveBeenCalledWith({
      where: { id: 'd1' },
      select: { kind: true },
    });
  });

  it('no row, a draft of the analysis kind and a retired kind are 404, not a run of someone else', async () => {
    const { service, prisma } = setup();
    for (const row of [null, { kind: 'analysis' }, { kind: 'summary_full' }]) {
      prisma.contentDraft.findUnique.mockResolvedValue(row);
      await expect(service.runKindOf('d1')).rejects.toBeInstanceOf(NotFoundException);
    }
  });
});
