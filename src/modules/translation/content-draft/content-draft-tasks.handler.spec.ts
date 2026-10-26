import { ContentDraft, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { DossierService } from '../dossier/dossier.service';
import { ContentDraftTasksHandler } from './content-draft-tasks.handler';
import { ContentDraftService } from './content-draft.service';

/**
 * Шаги заготовки (F05-10) на подменённых базе и модели: окончательные отказы пишут `failed`
 * с причиной одной записью с операцией, раздел пишется условием `building`, деньги - пауза.
 */

const PLAN = [
  { number: 1, title: 'Chapter 1', chapters: [1], why: '' },
  { number: 2, title: 'Chapters 2-3', chapters: [2, 3], why: '' },
];

const draftRow = (patch: Partial<ContentDraft> = {}): ContentDraft => ({
  id: 'd1',
  bookVersionId: 'v1',
  kind: 'summary_sections',
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

function setup(
  row: ContentDraft | null,
  answer: unknown = { title: 'T', text: 'Text.', additions: 'none', question: 'none' },
) {
  const tx = { contentDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    contentDraft: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ title: 'Book' }) },
    bookDossier: {
      findUnique: jest.fn().mockResolvedValue({ id: 'dos1', data: { summaryPlan: PLAN } }),
    },
    chapter: {
      findMany: jest.fn().mockResolvedValue([{ number: 1, title: 'C1', content: '<p>Anna.</p>' }]),
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
    savedSections: jest.fn().mockResolvedValue([{ title: 'S', text: 'Saved.' }]),
    savedFull: jest.fn().mockResolvedValue('Saved full.'),
    languageOf: jest.fn().mockResolvedValue('en'),
  };
  const handler = new ContentDraftTasksHandler(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
    tasks as unknown as LlmTaskService,
    {} as DossierService,
    drafts as unknown as ContentDraftService,
  );
  return { handler, prisma, llm, tasks, tx, drafts };
}

describe('ContentDraftTasksHandler (F05-10)', () => {
  it('a section is written under the building condition and the step continues', async () => {
    const { handler, prisma, tasks } = setup(draftRow());
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'continue' });
    expect(prisma.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    const [arg] = prisma.contentDraft.updateMany.mock.calls[0] as [
      { where: unknown; data: { data: { sections: unknown[] } } },
    ];
    expect(arg.where).toEqual({ id: 'd1', status: 'building' });
    expect(arg.data.data.sections).toEqual([
      expect.objectContaining({
        number: 1,
        readerChapter: 1,
        text: '<p>Text.</p>',
        question: null,
      }),
    ]);
    expect(tasks.failOperation).not.toHaveBeenCalled();
  });

  it('a discarded draft is not written back: the step ends', async () => {
    const { handler, prisma } = setup(draftRow());
    prisma.contentDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
  });

  it('the section title is cut to the section limit', async () => {
    const { handler, prisma } = setup(draftRow(), {
      title: 'x'.repeat(300),
      text: 'Text.',
      additions: 'none',
      question: 'none',
    });
    await handler.handler.run(task, ctx);
    const [arg] = prisma.contentDraft.updateMany.mock.calls[0] as [
      { data: { data: { sections: Array<{ title: string }> } } },
    ];
    expect(arg.data.data.sections[0].title).toHaveLength(200);
  });

  it.each([
    [
      'empty answer',
      { title: 'T', text: ' \n ', additions: '', question: '' },
      'DRAFT_INVALID_RESPONSE',
    ],
  ])(
    '%s - failed with the reason in the same record as the operation',
    async (_, answer, reason) => {
      const { handler, tasks, tx } = setup(draftRow(), answer);
      await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
      expect(tasks.failOperation).toHaveBeenCalledTimes(1);
      expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
        where: { id: 'd1', status: 'building' },
        data: { status: 'failed', failedReason: reason },
      });
    },
  );

  it('no plan in the dossier - DRAFT_NO_PLAN, the model is not called', async () => {
    const { handler, prisma, llm, tx } = setup(draftRow());
    prisma.bookDossier.findUnique.mockResolvedValue({ id: 'dos1', data: { summaryPlan: [] } });
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_NO_PLAN' } }),
    );
  });

  it('the input does not fit the model - DRAFT_TOO_LONG without a call', async () => {
    const { handler, llm, tx } = setup(draftRow());
    llm.stageFit.mockResolvedValue({ fits: false, model: 'm' });
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_TOO_LONG' } }),
    );
  });

  it('chapters without visible text - an empty section without a model call', async () => {
    const { handler, prisma, llm } = setup(draftRow());
    prisma.chapter.findMany.mockResolvedValue([{ number: 1, title: 'C1', content: '<p></p>' }]);
    await handler.handler.run(task, ctx);
    expect(llm.callStage).not.toHaveBeenCalled();
    const [arg] = prisma.contentDraft.updateMany.mock.calls[0] as [
      { data: { data: { sections: Array<{ text: string }> } } },
    ];
    expect(arg.data.data.sections[0].text).toBe('');
  });

  it('all plan sections done - ready with the operation done', async () => {
    const done = PLAN.map((p) => ({ number: p.number }));
    const { handler, tasks, tx } = setup(draftRow({ data: { sections: done } }));
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'ready', waitingFor: null },
    });
  });

  it('full: saved sections gone - DRAFT_INPUT_MISSING; ready with the text otherwise', async () => {
    const gone = setup(draftRow({ kind: 'summary_full' }), { text: 'Full.', question: 'none' });
    gone.drafts.savedSections.mockResolvedValue([]);
    await gone.handler.handler.run(task, ctx);
    expect(gone.tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_INPUT_MISSING' } }),
    );

    const ok = setup(draftRow({ kind: 'summary_full' }), { text: 'Full.', question: 'none' });
    await ok.handler.handler.run(task, ctx);
    // Ответ записан до итога шага, `ready` - вместе с концом операции.
    expect(ok.prisma.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(ok.prisma.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { data: { text: '<p>Full.</p>', question: null }, model: 'm' },
    });
    expect(ok.tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(ok.tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(ok.tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'ready' },
    });
  });

  it('brief: an empty answer is a refusal, not an empty draft', async () => {
    const { handler, tx } = setup(draftRow({ kind: 'summary_brief' }), { text: '', question: '' });
    await handler.handler.run(task, ctx);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'failed', failedReason: 'DRAFT_INVALID_RESPONSE' },
      }),
    );
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

  it('full already written before a pause - resume finishes it without a second model call', async () => {
    const { handler, llm, tasks, tx } = setup(
      draftRow({ kind: 'summary_full', data: { text: '<p>Full.</p>', question: null } }),
    );
    await expect(handler.handler.run(task, ctx)).resolves.toEqual({ kind: 'done' });
    expect(llm.callStage).not.toHaveBeenCalled();
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'ready' },
    });
  });

  it('a section HTML longer than the field limit - DRAFT_TOO_LONG', async () => {
    const { handler, tx } = setup(draftRow(), {
      title: 'T',
      text: 'x'.repeat(100_001),
      additions: 'none',
      question: 'none',
    });
    await handler.handler.run(task, ctx);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', failedReason: 'DRAFT_TOO_LONG' } }),
    );
  });

  it('an answer not in the form twice - DRAFT_INVALID_RESPONSE after one remark', async () => {
    const { handler, llm, tx } = setup(draftRow(), { title: 'T' });
    await handler.handler.run(task, ctx);
    expect(llm.callStage).toHaveBeenCalledTimes(2);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'failed', failedReason: 'DRAFT_INVALID_RESPONSE' },
      }),
    );
  });
});
