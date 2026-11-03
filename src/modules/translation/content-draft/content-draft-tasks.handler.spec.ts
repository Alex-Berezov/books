import { ContentDraft, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import { ContentDraftTasksHandler } from './content-draft-tasks.handler';
import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { ContentDraftService } from './content-draft.service';
import { SummaryWriteHandler } from '../summary-write/summary-write.handler';

/**
 * Шаги заготовки Analysis (F05-11) на подменённых базе и модели: окончательные отказы пишут
 * `failed` с причиной одной записью с операцией, ответ пишется условием `building`, деньги -
 * пауза; строящаяся заготовка снятого вида Summary отбрасывается путём дренажа (F06-3, А1).
 */

const draftRow = (patch: Partial<ContentDraft> = {}): ContentDraft => ({
  id: 'd1',
  bookVersionId: 'v1',
  kind: 'analysis',
  status: 'building',
  language: 'en',
  operationId: 'op1',
  data: null,
  model: null,
  failedReason: null,
  dossierId: 'dos1',
  glossaryId: null,
  waitingFor: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...patch,
});

const task = { id: 't1', operationId: 'op1', payload: { draftId: 'd1' } } as unknown as LlmTask;

const ctx = {
  callOptions: {},
  renewLease: jest.fn().mockResolvedValue(undefined),
} as unknown as LlmTaskContext;

function setup(row: ContentDraft | null, answer: unknown = {}) {
  const tx = { contentDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    contentDraft: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ title: 'Book' }) },
    bookDossier: {
      findUnique: jest.fn().mockResolvedValue({ id: 'dos1', sourceVersionId: 'src1', data: {} }),
    },
    bookGlossary: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const llm = {
    stageFit: jest.fn().mockResolvedValue({ fits: true, model: 'm' }),
    callStage: jest.fn().mockResolvedValue({
      json: answer,
      content: JSON.stringify(answer),
      model: 'm',
      callId: 'c1',
      costUsd: new Prisma.Decimal('0.001'),
    }),
  };
  const run = (fn?: (t: typeof tx) => Promise<void>) =>
    (fn ? fn(tx) : Promise.resolve()).then(() => true);
  const tasks = {
    completeOperation: jest.fn((_id: string, fn?: (t: typeof tx) => Promise<void>) => run(fn)),
    failOperation: jest.fn((_id: string, fn?: (t: typeof tx) => Promise<void>) => run(fn)),
    pauseOperation: jest.fn().mockResolvedValue(true),
  };
  const drafts = {
    languageOf: jest.fn().mockResolvedValue('en'),
    discardRetired: jest.fn().mockResolvedValue(undefined),
    versionChapters: jest
      .fn()
      .mockResolvedValue([{ number: 1, title: 'C1', content: '<p>Anna came &amp; left.</p>' }]),
    storedAnalysis: jest.fn().mockResolvedValue({
      stored: { ...EMPTY_BOOK_ANALYSIS, keyQuotes: [{ text: 'Saved', interpretation: 'Mine' }] },
      updatedAt: '2026-10-26T00:00:00.000Z',
    }),
  };
  const summaryWrite = {
    regenResume: jest.fn().mockResolvedValue([]),
    onRegenCancelled: jest.fn().mockResolvedValue(undefined),
  };
  const handler = new ContentDraftTasksHandler(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
    tasks as unknown as LlmTaskService,
    {} as DossierDemandService,
    drafts as unknown as ContentDraftService,
    summaryWrite as unknown as SummaryWriteHandler,
  );
  return { handler, prisma, llm, tasks, tx, drafts };
}

describe('ContentDraftTasksHandler (F05-11, F06-3)', () => {
  it.each(['summary_sections', 'summary_full', 'summary_brief'] as const)(
    'a building %s draft (retired kind) is discarded by the drain path, the model is not called',
    async (kind) => {
      const { handler, llm, tasks, drafts } = setup(draftRow({ kind }));
      await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
      expect(drafts.discardRetired).toHaveBeenCalledTimes(1);
      expect(drafts.discardRetired).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'd1', operationId: 'op1' }),
      );
      expect(llm.callStage).not.toHaveBeenCalled();
      expect(tasks.failOperation).not.toHaveBeenCalled();
    },
  );

  it('a row of another kind under a draft task - DRAFT_INPUT_MISSING, not a model call', async () => {
    const { handler, llm, tx, drafts } = setup(draftRow({ kind: 'summary_write' }));
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(drafts.discardRetired).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_INPUT_MISSING' } }),
    );
  });

  it('a retired draft that is no longer building - the step ends, nothing is discarded twice', async () => {
    const { handler, tasks, drafts } = setup(
      draftRow({ kind: 'summary_sections', status: 'discarded' }),
    );
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(drafts.discardRetired).not.toHaveBeenCalled();
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
  });

  it('a draft that is no longer building - the step ends without a call', async () => {
    const { handler, llm, tasks } = setup(draftRow({ status: 'discarded' }));
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
  });

  it('money refusals pause the operation with their reason, others - STEP_FAILED', async () => {
    const { handler, tasks } = setup(draftRow());
    await handler.handler.onFailed?.(task, 'LLM_BUDGET_EXCEEDED:ceiling');
    await handler.handler.onFailed?.(task, 'LLM_PROVIDER_ERROR');
    expect(tasks.pauseOperation.mock.calls).toEqual([
      ['op1', 'CEILING_REACHED'],
      ['op1', 'STEP_FAILED'],
    ]);
  });

  it('cancel from the operations page - failed DRAFT_CANCELLED; resume only a building draft', async () => {
    const { handler, prisma } = setup(draftRow());
    const tx = { contentDraft: { updateMany: jest.fn() } };
    await handler.onCancelled({ id: 'op1' } as never, tx as unknown as Prisma.TransactionClient);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { operationId: 'op1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_CANCELLED' },
    });
    await expect(handler.resumeTasks({ id: 'op1' } as never)).resolves.toEqual([
      expect.objectContaining({
        kind: 'content_draft',
        pairKey: 'op1:d1',
        payload: { draftId: 'd1' },
      }),
    ]);
    prisma.contentDraft.findUnique.mockResolvedValue(draftRow({ status: 'ready' }));
    await expect(handler.resumeTasks({ id: 'op1' } as never)).resolves.toEqual([]);
  });
});

describe('ContentDraftTasksHandler, analysis (F05-11)', () => {
  const analysisRow = (patch: Partial<ContentDraft> = {}) =>
    draftRow({ kind: 'analysis', ...patch });
  const answer = (quote: string, key = 'anna') => ({
    facts: { settingPlace: '', settingTime: '', narrator: '', structure: '' },
    characters: [],
    keyQuotes: [{ text: quote, chapter: 1, speakerKey: key === 'anna' ? '' : key }],
    style: [],
  });

  it('the draft is written before the end of the step, over the saved analysis', async () => {
    const { handler, prisma, tasks } = setup(analysisRow(), answer('Anna came & left.'));
    prisma.bookDossier.findUnique.mockResolvedValue({
      id: 'dos1',
      sourceVersionId: 'src1',
      data: { motifs: [{ image: 'the door', chapters: [1, 9] }] },
    });
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    const [arg] = prisma.contentDraft.updateMany.mock.calls[0] as [
      { where: unknown; data: { data: Record<string, unknown> } },
    ];
    expect(arg.where).toEqual({ id: 'd1', status: 'building' });
    expect(arg.data.data).toEqual({
      analysis: {
        language: 'en',
        keyQuotes: [
          { text: 'Saved', interpretation: 'Mine' },
          { text: 'Anna came & left.', chapter: 1 },
        ],
      },
      droppedQuotes: [],
      // Глава 9 - не этой версии (Р10).
      motifs: [{ image: 'the door', chapters: [1] }],
      dossierLanguage: 'en',
      analysisUpdatedAt: '2026-10-26T00:00:00.000Z',
    });
    expect(prisma.contentDraft.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tasks.completeOperation.mock.invocationCallOrder[0],
    );
  });

  it('a translated version: the run glossary goes to the model, the dossier language is the source one', async () => {
    const { handler, prisma, llm, drafts } = setup(
      analysisRow({ language: 'fr', glossaryId: 'g1' }),
      answer('Anna came & left.'),
    );
    prisma.bookGlossary.findUnique.mockResolvedValue({ data: { entries: ['Annette'] } });
    prisma.bookDossier.findUnique.mockResolvedValue({
      id: 'dos1',
      sourceVersionId: 'src1',
      data: {},
    });
    drafts.languageOf.mockResolvedValue('en');
    await handler.handler.run(task, ctx);
    // Текст глав и анализ - своей версии, язык досье - исходника досье.
    expect(drafts.versionChapters).toHaveBeenCalledWith('v1');
    expect(drafts.storedAnalysis).toHaveBeenCalledWith('v1');
    expect(drafts.languageOf).toHaveBeenCalledWith('src1');
    expect(prisma.bookGlossary.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.bookGlossary.findUnique).toHaveBeenCalledWith({
      where: { id: 'g1' },
      select: { data: true },
    });
    const [, , messages] = llm.callStage.mock.calls[0] as [
      string,
      string,
      Array<{ content: string }>,
    ];
    expect(messages.at(-1)?.content).toContain('Annette');
    const [arg] = prisma.contentDraft.updateMany.mock.calls[0] as [
      { data: { data: { dossierLanguage: string; analysis: { language: string } } } },
    ];
    expect(arg.data.data.dossierLanguage).toBe('en');
    expect(arg.data.data.analysis.language).toBe('fr');
  });

  it('a remark fixes the answer: the second clean answer is written, ready', async () => {
    const refused = answer('Anna came & left.', 'nobody');
    const { handler, llm, prisma, tasks } = setup(analysisRow(), refused);
    const clean = answer('Anna came & left.');
    llm.callStage.mockResolvedValueOnce({
      json: refused,
      content: '{}',
      model: 'm',
      callId: 'c1',
      costUsd: new Prisma.Decimal('0.001'),
    });
    llm.callStage.mockResolvedValueOnce({
      json: clean,
      content: JSON.stringify(clean),
      model: 'm',
      callId: 'c2',
      costUsd: new Prisma.Decimal('0.001'),
    });
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(llm.callStage).toHaveBeenCalledTimes(2);
    expect(prisma.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).not.toHaveBeenCalled();
  });

  it('an already written draft ends the step without a second call', async () => {
    const { handler, llm, tasks } = setup(
      analysisRow({ data: { analysis: { language: 'en' } } as unknown as Prisma.JsonValue }),
    );
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
  });

  it('a draft the save would refuse gets one remark, then DRAFT_INVALID_RESPONSE', async () => {
    const { handler, llm, tx } = setup(analysisRow(), answer('Anna came & left.', 'nobody'));
    await handler.handler.run(task, ctx);
    expect(llm.callStage).toHaveBeenCalledTimes(2);
    const [, , messages] = llm.callStage.mock.calls[1] as [
      string,
      string,
      Array<{ content: string }>,
    ];
    expect(messages.at(-1)?.content).toContain('unknown character key "nobody"');
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'failed', failedReason: 'DRAFT_INVALID_RESPONSE' },
      }),
    );
  });

  it('the whole text does not fit the model - DRAFT_TOO_LONG without a call', async () => {
    const { handler, llm, tx } = setup(analysisRow(), answer('x'));
    llm.stageFit.mockResolvedValue({ fits: false, model: 'm' });
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_TOO_LONG' },
    });
  });

  it('a text past the analysis model input - DRAFT_TOO_LONG without a call (F05-Rb, Р2)', async () => {
    const { handler, llm, tx, drafts } = setup(analysisRow(), answer('x'));
    drafts.versionChapters.mockResolvedValue(null);
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_TOO_LONG' },
    });
  });

  it('a version without chapter text - DRAFT_INPUT_MISSING without a call', async () => {
    const { handler, llm, tx, drafts } = setup(analysisRow(), answer('x'));
    drafts.versionChapters.mockResolvedValue([]);
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'failed', failedReason: 'DRAFT_INPUT_MISSING' },
    });
  });

  it('discarded while the model answered: the answer is not written, no ready', async () => {
    const { handler, prisma, tasks } = setup(analysisRow(), answer('Anna came & left.'));
    prisma.contentDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.completeOperation).not.toHaveBeenCalled();
  });

  it('a motif of a broken form does not break the step (Р10)', async () => {
    const { handler, prisma } = setup(analysisRow(), answer('Anna came & left.'));
    prisma.bookDossier.findUnique.mockResolvedValue({
      id: 'dos1',
      sourceVersionId: 'src1',
      data: { motifs: [{ image: 'rain' }, null, { chapters: [1] }] },
    });
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    const [arg] = prisma.contentDraft.updateMany.mock.calls[0] as [
      { data: { data: { motifs: unknown } } },
    ];
    expect(arg.data.data.motifs).toEqual([{ image: 'rain', chapters: [] }]);
  });
});
