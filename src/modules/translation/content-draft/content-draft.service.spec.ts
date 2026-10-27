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
    $executeRaw: jest.fn().mockResolvedValue(1),
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

  it('added mark: updatedAt is written in UTC explicitly, not by now() of the session (F05-11, Р22)', async () => {
    const { service, prisma } = setup();
    const ready = draft({
      kind: 'summary_sections',
      status: 'ready',
      data: { sections: [{ number: 1 }] },
    });
    prisma.contentDraft.findUnique.mockResolvedValue(ready);
    await service.markSectionAdded('d1', 1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).not.toMatch(/now\(\)/i);
    // Вложенный `Prisma.sql` - объект с полем `sql`; голый `Date` или `now()` - нет.
    const stamps = values
      .map((v) => (v as { sql?: unknown } | null)?.sql)
      .filter((v): v is string => typeof v === 'string');
    expect(stamps).toEqual([expect.stringContaining("AT TIME ZONE 'UTC'")]);
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
