import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { ContentDraftService } from '../content-draft/content-draft.service';
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
    expect(body).toMatchObject({ code: 'SUMMARY_FIELD_CHANGED', acceptedIndexes: [0] });
  });
});
