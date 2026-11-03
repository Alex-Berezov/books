import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { ContentDraftService } from '../content-draft/content-draft.service';
import { SummaryWriteFields } from './summary-write.fields';
import { SummaryWriteHandler } from './summary-write.handler';
import { startConflict, SummaryWriteService } from './summary-write.service';

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

/**
 * P2002 старта (`tech.md` §4 п.3) в форме адаптера (`@prisma/adapter-pg`: `meta.target` нет, имя
 * индекса - в `driverAdapterError.cause.constraint.index`): индекс автозапуска - тихий выход только
 * у автозапуска; частичный индекс строящегося и пустой разбор - `DRAFT_IN_PROGRESS`.
 */
describe('startConflict', () => {
  const p2002 = (index: string | null) =>
    new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        modelName: 'ContentDraft',
        driverAdapterError: {
          cause: { kind: 'UniqueConstraintViolation', constraint: index ? { index } : {} },
        },
      },
    });
  const codeOf = (error: unknown) =>
    ((error as ConflictException).getResponse() as { code: string }).code;
  const AUTOSTART_INDEX = 'ContentDraft_translationRunLanguageId_kind_key';

  it('индекс автозапуска у автозапуска - AUTOSTART_DUPLICATE', () => {
    expect(codeOf(startConflict(p2002(AUTOSTART_INDEX), true))).toBe('AUTOSTART_DUPLICATE');
  });

  it('индекс автозапуска у ручного старта, строящийся ход и пустой разбор - DRAFT_IN_PROGRESS', () => {
    expect(codeOf(startConflict(p2002(AUTOSTART_INDEX), false))).toBe('DRAFT_IN_PROGRESS');
    expect(codeOf(startConflict(p2002('ContentDraft_building_key'), true))).toBe(
      'DRAFT_IN_PROGRESS',
    );
    expect(codeOf(startConflict(p2002(null), true))).toBe('DRAFT_IN_PROGRESS');
  });

  it('не P2002 - как есть', () => {
    const other = new Error('x');
    expect(startConflict(other, true)).toBe(other);
  });
});
