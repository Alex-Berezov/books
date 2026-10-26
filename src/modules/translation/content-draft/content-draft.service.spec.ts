import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { DossierService } from '../dossier/dossier.service';
import { ContentDraftService } from './content-draft.service';

/**
 * Сервис заготовки (F05-10) на подменённой базе: отказы до операции (потолок, предпосылка,
 * лимит ниже досье), вторая строящаяся - 409 по уникальному индексу, «не нужна» - отмена
 * операции у строящейся и только статус у прочих.
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
  kind: 'summary_full',
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
    bookSummarySection: {
      findMany: jest.fn().mockResolvedValue([{ title: 'S', text: '<p>Saved.</p>' }]),
    },
    bookSummary: { findUnique: jest.fn().mockResolvedValue(null) },
    bookGlossary: { findUnique: jest.fn().mockResolvedValue(null) },
    contentDraft: {
      findUnique: jest.fn().mockResolvedValue(draft()),
      findFirst: jest.fn().mockResolvedValue(null),
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
  );
  return { service, prisma, llm, budget, tasks, tx };
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

describe('ContentDraftService (F05-10)', () => {
  it('ceiling reached - 409 before any operation or draft', async () => {
    const { service, budget, tx } = setup();
    budget.ceilingReached.mockResolvedValue(true);
    await expect(codeOf(service.start('v1', 'summary_full', undefined, 'u1'))).resolves.toBe(
      'LLM_CEILING_REACHED',
    );
    expect(tx.llmOperation.create).not.toHaveBeenCalled();
    expect(tx.contentDraft.create).not.toHaveBeenCalled();
  });

  it('full without a saved section with text - 409 SUMMARY_SECTIONS_MISSING; brief without the full - SUMMARY_FULL_MISSING', async () => {
    const { service, prisma } = setup();
    prisma.bookSummarySection.findMany.mockResolvedValue([
      { title: 'Image only', text: '<figure><img src="a.jpg"></figure>' },
    ]);
    await expect(codeOf(service.estimate('v1', 'summary_full'))).resolves.toBe(
      'SUMMARY_SECTIONS_MISSING',
    );
    prisma.bookSummary.findUnique.mockResolvedValue({ summary: '<p></p>' });
    await expect(codeOf(service.estimate('v1', 'summary_brief'))).resolves.toBe(
      'SUMMARY_FULL_MISSING',
    );
  });

  it('start: the previous ready or failed is discarded, the draft and the task in one transaction', async () => {
    const { service, prisma, tx, tasks } = setup();
    await service.start('v1', 'summary_full', undefined, 'u1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'summary_full', status: { in: ['ready', 'failed'] } },
      data: { status: 'discarded' },
    });
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'content_draft', payload: { draftId: 'd1' } }),
      tx,
    );
  });

  it('a second building draft - the unique index turns into 409 DRAFT_IN_PROGRESS', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(codeOf(service.start('v1', 'summary_full', undefined, 'u1'))).resolves.toBe(
      'DRAFT_IN_PROGRESS',
    );
  });

  it('discard: a building draft cancels its operation; a ready one only changes status', async () => {
    const building = setup();
    await building.service.discard('d1');
    expect(building.tasks.cancelOperation).toHaveBeenCalledTimes(1);
    expect(building.tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'discarded' },
    });

    const ready = setup();
    ready.prisma.contentDraft.findUnique.mockResolvedValue(draft({ status: 'ready' }));
    await ready.service.discard('d1');
    expect(ready.tasks.cancelOperation).not.toHaveBeenCalled();
    expect(ready.prisma.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: { not: 'discarded' } },
      data: { status: 'discarded' },
    });
  });

  it('latest: none - null; sections of a sections draft, text of a text draft', async () => {
    const { service, prisma } = setup();
    await expect(service.latest('v1', 'summary_full')).resolves.toEqual({ draft: null });
    prisma.contentDraft.findFirst.mockResolvedValue(
      draft({ status: 'ready', data: { text: '<p>Full.</p>', question: null } }),
    );
    await expect(service.latest('v1', 'summary_full')).resolves.toMatchObject({
      draft: { status: 'ready', text: '<p>Full.</p>', sections: null, waitingFor: null },
    });
  });
});
