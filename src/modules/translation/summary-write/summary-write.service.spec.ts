import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { ContentDraftService } from '../content-draft/content-draft.service';
import { PREVIOUS_BATCH } from '../draft-quality/run-regen';
import { SummaryWriteFields } from './summary-write.fields';
import { SummaryWriteHandler } from './summary-write.handler';
import { SummaryWriteService } from './summary-write.service';

/**
 * «Accept all» (`tech.md` §5): отказ по одному - 409 со списком уже записанного, и пустым тоже -
 * клиент отличает «ничего не записано» от «неизвестно» (ревью `F06-3`, перенесено в `F06-5`).
 */

const proposed = (number: number) => ({
  target: 'section',
  number,
  text: 'Text.',
  outcome: 'proposed',
  verdict: 'ok',
  regen: null,
});

function setup() {
  const row = {
    id: 'd1',
    kind: 'summary_write',
    status: 'ready',
    data: { items: [proposed(1), proposed(2)] },
  };
  const prisma = { contentDraft: { findUnique: jest.fn().mockResolvedValue(row) } };
  const fields = {
    settle: jest.fn(),
    chapterChanges: jest.fn().mockResolvedValue([]),
    accept: jest.fn(),
  };
  const service = new SummaryWriteService(
    prisma as unknown as PrismaService,
    {} as LlmService,
    {} as LlmBudgetService,
    {} as LlmTaskService,
    {} as ContentDraftService,
    fields as unknown as SummaryWriteFields,
    {} as SummaryWriteHandler,
  );
  return { service, fields };
}

async function refusal(service: SummaryWriteService): Promise<Record<string, unknown>> {
  const error: unknown = await service.acceptAll('d1').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as Record<string, unknown>;
}

describe('SummaryWriteService.acceptAll: отказ посреди', () => {
  it('отказ на первом тексте - 409 с пустым acceptedIndexes', async () => {
    const { service, fields } = setup();
    fields.accept.mockRejectedValueOnce(llmTaskConflict('SUMMARY_FIELD_CHANGED', 'changed'));
    const body = await refusal(service);
    expect(body).toMatchObject({ code: 'SUMMARY_FIELD_CHANGED', acceptedIndexes: [] });
  });

  it('отказ после принятого - 409 со списком принятых', async () => {
    const { service, fields } = setup();
    fields.accept
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(llmTaskConflict('SUMMARY_FIELD_CHANGED', 'changed'));
    const body = await refusal(service);
    expect(body).toMatchObject({
      code: 'SUMMARY_FIELD_CHANGED',
      acceptedIndexes: [0],
      stoppedIndex: 1,
    });
  });
});

describe('SummaryWriteService.start: прежние ходы (T191, LEGACY-498)', () => {
  it('ручной старт отбрасывает все прежние ходы порциями и отменяет перегенерации каждого', async () => {
    const batch = Array.from({ length: PREVIOUS_BATCH }, (_, n) => ({
      id: `a${String(n).padStart(3, '0')}`,
      operationIds: n === 0 ? ['op-0'] : [],
    }));
    const pages = [batch, [{ id: 'b', operationIds: ['op-1'] }]];
    let reads = 0;
    const tx = {
      // Порции прежних ходов - по тексту запроса; прочие `$queryRaw` (замок) - пусто.
      $queryRaw: jest.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('jsonb_path_query_array') ? (pages[reads++] ?? []) : [],
        ),
      ),
      contentDraft: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 101 }),
        create: jest.fn().mockResolvedValue({ id: 'new', bookVersionId: 'v1', language: 'en' }),
      },
      llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op-new' }) },
    };
    const db = { $transaction: jest.fn((cb: (t: unknown) => Promise<unknown>) => cb(tx)) };
    const tasks = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      cancelOperation: jest.fn().mockResolvedValue(true),
    };
    const llm = { assertEnabled: jest.fn(), operationData: jest.fn().mockResolvedValue({}) };
    const budget = { ceilingReached: jest.fn().mockResolvedValue(false) };
    const service = new SummaryWriteService(
      db as unknown as PrismaService,
      llm as unknown as LlmService,
      budget as unknown as LlmBudgetService,
      tasks as unknown as LlmTaskService,
      {} as ContentDraftService,
      {} as SummaryWriteFields,
      { clearRegenMark: jest.fn() } as unknown as SummaryWriteHandler,
    );
    const internals = service as unknown as Record<string, unknown>;
    internals.estimateOf = jest.fn().mockResolvedValue({
      suggestedLimitUsd: new Prisma.Decimal(1),
      contextLimitUsd: new Prisma.Decimal(0),
      language: 'en',
      dto: { dossier: null },
      context: { run: null },
    });
    internals.ownership = jest.fn().mockResolvedValue([[], []]);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'new' } as never);

    await service.start('v1', undefined, 'u1');

    expect(reads).toBe(2);
    expect(tx.contentDraft.findMany).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'summary_write', status: { in: ['ready', 'failed'] } },
      data: { status: 'discarded' },
    });
    expect((tasks.cancelOperation.mock.calls as Array<[string]>).map(([id]) => id)).toEqual([
      'op-0',
      'op-1',
    ]);
  });
});
