import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { DossierService } from '../dossier/dossier.service';
import { Prisma } from '@prisma/client';
import { ContentDraftService, contextLimits } from './content-draft.service';
import { DRAFT_LIMIT_FACTOR } from './content-draft.constants';

/**
 * Общая часть ходов на подменённой базе: дренаж снятых видов (Summary `F05-10` - F06-3, А1;
 * Analysis `F05-11` - F07-3a) и вид хода по строке для общих ручек (F07-1b, В6).
 */

function setup() {
  const tx = { contentDraft: { updateMany: jest.fn() } };
  const prisma = {
    contentDraft: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
  };
  const tasks = {
    cancelOperation: jest.fn(
      async (_id: string, fn: (t: typeof tx) => Promise<void>) => (await fn(tx), true),
    ),
  };
  const service = new ContentDraftService(
    prisma as unknown as PrismaService,
    tasks as unknown as LlmTaskService,
    {} as DossierService,
    {} as DossierDemandService,
  );
  return { service, prisma, tasks, tx };
}

describe('ContentDraftService retired drafts (F06-3, А1; F07-3a)', () => {
  const building = (id: string, operationId: string) => ({ id, operationId });

  it('drains building rows of the retired kinds by their operation, the Discard draft path', async () => {
    const { service, prisma, tasks, tx } = setup();
    prisma.contentDraft.findMany.mockResolvedValueOnce([
      building('s1', 'op-s1'),
      building('f1', 'op-f1'),
    ]);
    await expect(service.drainRetiredDrafts()).resolves.toBe(2);
    expect(prisma.contentDraft.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.contentDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: { in: ['summary_sections', 'summary_full', 'summary_brief', 'analysis'] },
          status: 'building',
        },
        take: 100,
      }),
    );
    // Отмена - по операции строки, а не по виду задачи `content_draft`.
    expect(tasks.cancelOperation.mock.calls.map((c) => c[0])).toEqual(['op-s1', 'op-f1']);
    // По строке: одна запись в транзакции отмены и одна запасная - не больше.
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.contentDraft.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'building' },
      data: { status: 'discarded' },
    });
    // Запасная - только строящейся: успевшая стать готовой строка не отбрасывается.
    expect(prisma.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'f1', status: 'building' },
      data: { status: 'discarded' },
    });
  });

  it('nothing to drain - nothing changes; a repeat is a no-op', async () => {
    const { service, prisma, tasks } = setup();
    await expect(service.drainRetiredDrafts()).resolves.toBe(0);
    await expect(service.drainRetiredDrafts()).resolves.toBe(0);
    expect(tasks.cancelOperation).not.toHaveBeenCalled();
    expect(prisma.contentDraft.updateMany).not.toHaveBeenCalled();
  });

  it('a full batch reads the next one until a short batch', async () => {
    const { service, prisma } = setup();
    const batch = Array.from({ length: 100 }, (_, i) => building(`d${i}`, `op${i}`));
    prisma.contentDraft.findMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([building('last', 'op-last')]);
    await expect(service.drainRetiredDrafts()).resolves.toBe(101);
    expect(prisma.contentDraft.findMany).toHaveBeenCalledTimes(2);
  });

  it('bootstrap drains the retired kinds: building rows are discarded at the start (А1)', async () => {
    const { service, prisma, tasks } = setup();
    prisma.contentDraft.findMany.mockResolvedValueOnce([building('s1', 'op-s1')]);
    const drain = jest.spyOn(service, 'drainRetiredDrafts');
    await service.onApplicationBootstrap();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(tasks.cancelOperation).toHaveBeenCalledTimes(1);
    expect(tasks.cancelOperation).toHaveBeenCalledWith('op-s1', expect.any(Function));
  });

  it('a failed drain at bootstrap does not break the start', async () => {
    const { service, prisma } = setup();
    prisma.contentDraft.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
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

describe('contextLimits (T177)', () => {
  const none = {
    run: null,
    dossier: null,
    glossaryData: null,
    dossierLine: null,
    glossaryLine: null,
  };

  it('the limit is the stage cost times 1.5 when no context is built first', () => {
    expect(DRAFT_LIMIT_FACTOR).toBe('1.5');
    const limits = contextLimits(none, new Prisma.Decimal('2'));
    expect(limits.suggestedLimitUsd.toString()).toBe('3');
    expect(limits.contextLimitUsd.toString()).toBe('0');
  });
});
