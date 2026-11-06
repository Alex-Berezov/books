import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import { BOOK_ANALYSIS_TX_OPTIONS } from '../../book-analysis/book-analysis-lock';
import type { LlmBudgetService } from '../../llm/llm-budget.service';
import type { LlmService } from '../../llm/llm.service';
import type { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import type { ContentDraftService } from '../content-draft/content-draft.service';
import {
  AnalysisItem,
  AnalysisTarget,
  analysisDataJson,
  emptyAnalysisData,
} from './analysis-write.data';
import type { AnalysisWriteFields } from './analysis-write.fields';
import type { AnalysisWriteHandler } from './analysis-write.handler';
import { AnalysisWriteService } from './analysis-write.service';

/**
 * Ход анализа на подменённых базе и коллабораторах (`F07-1a`, `F07-1b`): отказы старта до записи,
 * запись старта (отброс прежнего хода, индекс «один строящийся»), «Accept all» по порядку с
 * остатком, «Regenerate» (границы и постановка задачи), отмена хода.
 */

const codeOf = (error: unknown): string =>
  ((error as ConflictException).getResponse() as { code: string }).code;

const item = (target: AnalysisTarget, patch: Partial<AnalysisItem> = {}): AnalysisItem => ({
  target,
  step: target === 'keyQuotes' ? 2 : target === 'themes' ? 3 : 1,
  verdict: 'ok',
  remarks: [],
  review: null,
  outcome: 'proposed',
  hash: 'h',
  value: [],
  failedReason: null,
  links: false,
  regen: null,
  regenFailedReason: null,
  ...patch,
});

const rowOf = (items: AnalysisItem[], status = 'ready') => ({
  id: 'd1',
  bookVersionId: 'v1',
  language: 'en',
  kind: 'analysis_write',
  status,
  operationId: 'op1',
  data: analysisDataJson({ ...emptyAnalysisData({}, {}), items }),
});

interface Estimate {
  suggestedLimitUsd: Prisma.Decimal;
  contextLimitUsd: Prisma.Decimal;
  run: { dossierId: string; glossaryId: string | null } | null;
  language: string;
  dto: { dossier: { refusedTooLong: boolean } | null };
}

function setup(row: ReturnType<typeof rowOf> | null = null) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    contentDraft: {
      findMany: jest.fn().mockResolvedValue([] as Array<{ id: string; data: unknown }>),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: 'new', bookVersionId: 'v1', language: 'en' }),
    },
    llmOperation: { create: jest.fn().mockResolvedValue({ id: 'op-new' }) },
  };
  const prisma = {
    contentDraft: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ language: 'en' }) },
    chapter: { findMany: jest.fn().mockResolvedValue([]) },
    llmOperation: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn<Promise<unknown>, [(client: typeof tx) => unknown, unknown?]>((cb) =>
      Promise.resolve(cb(tx)),
    ),
  };
  const llm = {
    assertEnabled: jest.fn(),
    operationData: jest.fn().mockResolvedValue({ kind: 'draft' }),
  };
  const budget = { ceilingReached: jest.fn().mockResolvedValue(false) };
  const tasks = {
    enqueue: jest.fn().mockResolvedValue(undefined),
    cancelOperation: jest.fn().mockResolvedValue(true),
  };
  const fields = {
    ownership: jest.fn().mockResolvedValue({ owns: {}, written: {} }),
    accept: jest.fn().mockResolvedValue(undefined),
    discardItem: jest.fn().mockResolvedValue(undefined),
    mutate: jest.fn(),
  };
  const handler = { clearRegenMark: jest.fn().mockResolvedValue(undefined) };
  const service = new AnalysisWriteService(
    prisma as unknown as PrismaService,
    llm as unknown as LlmService,
    budget as unknown as LlmBudgetService,
    tasks as unknown as LlmTaskService,
    {} as ContentDraftService,
    fields as unknown as AnalysisWriteFields,
    handler as unknown as AnalysisWriteHandler,
  );
  // Ответ хода собирает `toDto` (операция, замена) - здесь он не предмет проверки.
  jest.spyOn(service, 'get').mockResolvedValue({} as never);
  const internals = service as unknown as {
    estimateOf: (versionId: string) => Promise<Estimate>;
    regenUsd: () => Promise<Prisma.Decimal>;
  };
  const estimate = (patch: Partial<Estimate> = {}): Estimate => ({
    suggestedLimitUsd: new Prisma.Decimal('2'),
    contextLimitUsd: new Prisma.Decimal('1'),
    run: { dossierId: 'dos1', glossaryId: null },
    language: 'en',
    dto: { dossier: null },
    ...patch,
  });
  return { service, prisma, tx, llm, budget, tasks, fields, handler, internals, estimate };
}

describe('AnalysisWriteService.start: refusals before any write (F07-1a)', () => {
  it('an unknown version - 404, nothing is created', async () => {
    const { service, prisma, tx } = setup();
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.start('v1', undefined, 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.contentDraft.create).not.toHaveBeenCalled();
  });

  it('a version without chapter text - 409 SOURCE_HAS_NO_CHAPTERS', async () => {
    const { service, prisma } = setup();
    prisma.chapter.findMany.mockResolvedValue([{ number: 1, title: 'C1', content: '<p>   </p>' }]);
    const error = await service.start('v1', undefined, 'u1').catch((e: unknown) => e);
    expect(codeOf(error)).toBe('SOURCE_HAS_NO_CHAPTERS');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no OpenRouter key - 503 before the estimate', async () => {
    const { service, llm, internals } = setup();
    const spy = jest.spyOn(internals, 'estimateOf');
    llm.assertEnabled.mockImplementation(() => {
      throw new ServiceUnavailableException({ code: 'LLM_DISABLED' });
    });
    await expect(service.start('v1', undefined, 'u1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('the dossier summary is refused at the estimate - 409 DOSSIER_TOO_LONG', async () => {
    const { service, internals, estimate, prisma } = setup();
    jest
      .spyOn(internals, 'estimateOf')
      .mockResolvedValue(estimate({ dto: { dossier: { refusedTooLong: true } } }));
    const error = await service.start('v1', undefined, 'u1').catch((e: unknown) => e);
    expect(codeOf(error)).toBe('DOSSIER_TOO_LONG');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the spending ceiling is reached - 409 LLM_CEILING_REACHED', async () => {
    const { service, internals, estimate, budget, prisma } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    budget.ceilingReached.mockResolvedValue(true);
    const error = await service.start('v1', undefined, 'u1').catch((e: unknown) => e);
    expect(codeOf(error)).toBe('LLM_CEILING_REACHED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a limit below the dossier and glossary built first - 400 DRAFT_LIMIT_TOO_LOW', async () => {
    const { service, internals, estimate, prisma } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    const error: unknown = await service
      .start('v1', new Prisma.Decimal('0.5'), 'u1')
      .catch((e: unknown) => e);
    expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
      'DRAFT_LIMIT_TOO_LOW',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AnalysisWriteService.start: the write of the start (F07-1a)', () => {
  const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

  it('the previous ready or failed run is discarded in the same transaction, under the analysis lock with the deadline of its writers; the task is enqueued', async () => {
    const { service, internals, estimate, tx, prisma, tasks, fields } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    prisma.contentDraft.findUnique.mockResolvedValue(rowOf([], 'building'));
    tx.contentDraft.findMany.mockResolvedValue([{ id: 'old', data: rowOf([]).data }]);
    await service.start('v1', undefined, 'u1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      BOOK_ANALYSIS_TX_OPTIONS,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.findMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'analysis_write', status: { in: ['ready', 'failed'] } },
      select: { id: true, data: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.contentDraft.updateMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', kind: 'analysis_write', status: { in: ['ready', 'failed'] } },
      data: { status: 'discarded' },
    });
    expect(fields.ownership).toHaveBeenCalledTimes(1);
    expect(fields.ownership).toHaveBeenCalledWith(tx, 'v1');
    expect(tx.contentDraft.create).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    expect(tasks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'analysis_write', payload: { draftId: 'new' } }),
      tx,
    );
    // Перегенераций у отброшенного хода нет - отменять нечего.
    expect(tasks.cancelOperation).not.toHaveBeenCalled();
  });

  it('more previous runs than a page: all are discarded by one write, the regenerations of every page are cancelled (/fix 3, blocker 6)', async () => {
    const { service, internals, estimate, tx, tasks } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    const regen = (n: number) => ({
      operationId: `op-${n}`,
      remark: null,
      pending: null,
      previous: null,
    });
    const page = Array.from({ length: 100 }, (_, n) => ({
      id: `a${String(n).padStart(3, '0')}`,
      data: rowOf(n === 0 ? [item('characters', { regen: regen(0) })] : []).data,
    }));
    tx.contentDraft.findMany
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ id: 'b', data: rowOf([item('style', { regen: regen(1) })]).data }]);
    await service.start('v1', undefined, 'u1');
    expect(tx.contentDraft.findMany).toHaveBeenCalledTimes(2);
    expect(tx.contentDraft.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: 'a099' } }) }),
    );
    expect(tx.contentDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tasks.cancelOperation).toHaveBeenCalledTimes(2);
    expect((tasks.cancelOperation.mock.calls as Array<[string]>).map(([id]) => id)).toEqual([
      'op-0',
      'op-1',
    ]);
  });

  it('the regenerations of the discarded previous run are cancelled after the commit, each clearing its mark (/fix 2, blocker 3)', async () => {
    const { service, internals, estimate, tx, prisma, tasks, handler } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    const regen = { operationId: 'op9', remark: null, pending: null, previous: null };
    tx.contentDraft.findMany.mockResolvedValue([
      { id: 'old', data: rowOf([item('characters', { regen })]).data },
    ]);
    const order: string[] = [];
    prisma.$transaction.mockImplementation((cb) => {
      order.push('start transaction');
      return Promise.resolve(cb(tx));
    });
    tasks.cancelOperation.mockImplementation((id: string, fn: (t: unknown) => Promise<void>) => {
      order.push(`cancel ${id}`);
      return fn('tx').then(() => true);
    });
    await service.start('v1', undefined, 'u1');
    expect(order).toEqual(['start transaction', 'cancel op9']);
    expect(handler.clearRegenMark).toHaveBeenCalledTimes(1);
    expect(handler.clearRegenMark).toHaveBeenCalledWith('op9', 'tx');
  });

  it('a second building run (the partial unique index, P2002) - 409 DRAFT_IN_PROGRESS', async () => {
    const { service, internals, estimate, prisma } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    prisma.$transaction.mockRejectedValue(p2002);
    const error = await service.start('v1', undefined, 'u1').catch((e: unknown) => e);
    expect(codeOf(error)).toBe('DRAFT_IN_PROGRESS');
  });

  it('any other error of the write comes out as it is', async () => {
    const { service, internals, estimate, prisma } = setup();
    jest.spyOn(internals, 'estimateOf').mockResolvedValue(estimate());
    const boom = new Error('db down');
    prisma.$transaction.mockRejectedValue(boom);
    await expect(service.start('v1', undefined, 'u1')).rejects.toBe(boom);
  });
});

describe('AnalysisWriteService.acceptAll (F07-1b)', () => {
  it('interpretations first, then characters, then quotations, the links last; each one by one', async () => {
    const { service, fields } = setup(
      rowOf([
        item('keyQuotes'), // 0: шаг 2
        item('characters', { links: true, step: 3 }), // 1: связи
        item('characters'), // 2: шаг 1
        item('themes'), // 3: шаг 3
        item('style', { outcome: 'written' }), // 4: не предложение
      ]),
    );
    await service.acceptAll('d1');
    expect(
      (fields.accept.mock.calls as Array<[unknown, number]>).map(([, index]) => index),
    ).toEqual([3, 2, 0, 1]);
  });

  it('a 409 of the run (it is no longer ready) stops the pass with the list of what is written already, an empty list too (/fix 3, blocker 2)', async () => {
    const ready = rowOf([item('themes'), item('characters')]);
    const s = setup(ready);
    s.fields.accept.mockRejectedValueOnce(llmTaskConflict('ANALYSIS_ITEM_NOT_PROPOSED', 'gone'));
    // Строка перечитана после отказа: ход отброшен - отказ уровня хода.
    s.prisma.contentDraft.findUnique
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(rowOf([item('themes'), item('characters')], 'discarded'));
    let body = (
      (await s.service.acceptAll('d1').catch((e: unknown) => e)) as ConflictException
    ).getResponse();
    expect(body).toMatchObject({ code: 'ANALYSIS_WRITE_NOT_READY', acceptedIndexes: [] });
    const t = setup(ready);
    t.fields.accept
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(llmTaskConflict('ANALYSIS_BLOCK_CHANGED', 'changed'));
    t.prisma.contentDraft.findUnique
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(rowOf([item('themes'), item('characters')], 'discarded'));
    body = (
      (await t.service.acceptAll('d1').catch((e: unknown) => e)) as ConflictException
    ).getResponse();
    expect(body).toMatchObject({ code: 'ANALYSIS_WRITE_NOT_READY', acceptedIndexes: [0] });
  });

  it('links proposals born by an accepted theme (decision Б) are accepted in the same pass', async () => {
    const s = setup(rowOf([item('themes')]));
    let items = [item('themes')];
    s.prisma.contentDraft.findUnique.mockImplementation(() => Promise.resolve(rowOf(items)));
    s.fields.accept.mockImplementation((_row: unknown, index: number) => {
      items = items.map((it, i) => (i === index ? { ...it, outcome: 'accepted' } : it));
      // «Accept» темы рождает предложение связей героев.
      if (index === 0) items = [...items, item('characters', { step: 3, links: true })];
      return Promise.resolve();
    });
    await s.service.acceptAll('d1');
    expect((s.fields.accept.mock.calls as Array<[unknown, number]>).map(([, i]) => i)).toEqual([
      0, 1,
    ]);
  });

  it('a refusal that is not a 409 (400 of the import) also carries what is written; an error without a body comes out as it is', async () => {
    const s = setup(rowOf([item('themes'), item('characters')]));
    s.fields.accept
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BadRequestException({ code: 'X', message: 'bad' }));
    const error = (await s.service.acceptAll('d1').catch((e: unknown) => e)) as BadRequestException;
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: 'X', acceptedIndexes: [0] });
    const boom = new Error('db down');
    const t = setup(rowOf([item('themes')]));
    t.fields.accept.mockRejectedValueOnce(boom);
    await expect(t.service.acceptAll('d1')).rejects.toBe(boom);
  });

  it.each(['ANALYSIS_WRITE_REFUSED', 'ANALYSIS_BLOCK_CHANGED', 'ANALYSIS_REGEN_IN_PROGRESS'])(
    'a 409 %s of the proposal itself skips it, the rest of the pass goes on; the answer names it in skipped (/fix 2 blocker 5, /fix 3 blocker 2; F07-3a)',
    async (code) => {
      const s = setup(rowOf([item('themes'), item('characters'), item('keyQuotes')]));
      s.fields.accept.mockImplementation((_row: unknown, index: number) =>
        index === 1 ? Promise.reject(llmTaskConflict(code, 'refused')) : Promise.resolve(),
      );
      const answer = await s.service.acceptAll('d1');
      expect(answer.skipped).toEqual([{ index: 1, code }]);
      expect(s.fields.accept).toHaveBeenCalledTimes(3);
      expect((s.fields.accept.mock.calls as Array<[unknown, number]>).map(([, i]) => i)).toEqual([
        0, 1, 2,
      ]);
    },
  );

  it('several refused proposals are all named in skipped in the order of the tries; the accepted ones are not (F07-3a)', async () => {
    const s = setup(
      rowOf([item('themes'), item('characters'), item('keyQuotes'), item('style', { step: 2 })]),
    );
    s.fields.accept.mockImplementation((_row: unknown, index: number) =>
      index === 0
        ? Promise.reject(llmTaskConflict('ANALYSIS_BLOCK_CHANGED', 'changed'))
        : index === 2
          ? Promise.reject(llmTaskConflict('ANALYSIS_WRITE_REFUSED', 'refused'))
          : Promise.resolve(),
    );
    const answer = await s.service.acceptAll('d1');
    expect(s.fields.accept).toHaveBeenCalledTimes(4);
    expect(answer.skipped).toEqual([
      { index: 0, code: 'ANALYSIS_BLOCK_CHANGED' },
      { index: 2, code: 'ANALYSIS_WRITE_REFUSED' },
    ]);
  });

  it('a 409 of the proposal outside the closed list or with a text body is skipped without a reason and logged, not a 500 (F07-3a)', async () => {
    const s = setup(rowOf([item('themes'), item('characters')]));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    s.fields.accept.mockImplementation((_row: unknown, index: number) =>
      Promise.reject(
        index === 0
          ? llmTaskConflict('SOMETHING_NEW', 'new')
          : new ConflictException('a plain text body'),
      ),
    );
    const answer = await s.service.acceptAll('d1');
    expect(s.fields.accept).toHaveBeenCalledTimes(2);
    expect(answer.skipped).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([m]) => String(m))).toEqual([
      expect.stringContaining('item 0 skipped with SOMETHING_NEW'),
      expect.stringContaining('item 1 skipped with HTTP_409'),
    ]);
    warn.mockRestore();
  });

  it('a proposal that is no longer a proposal (accepted by another request) is passed by without a reason (F07-3a)', async () => {
    const s = setup(rowOf([item('themes'), item('characters')]));
    s.fields.accept.mockImplementation((_row: unknown, index: number) =>
      index === 0
        ? Promise.reject(llmTaskConflict('ANALYSIS_ITEM_NOT_PROPOSED', 'gone'))
        : Promise.resolve(),
    );
    const answer = await s.service.acceptAll('d1');
    expect(s.fields.accept).toHaveBeenCalledTimes(2);
    expect(answer.skipped).toEqual([]);
  });

  it('a regenerating block is skipped; a run that is not ready - 409 ANALYSIS_WRITE_NOT_READY', async () => {
    const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
    const { service, fields } = setup(rowOf([item('themes', { regen }), item('characters')]));
    const answer = await service.acceptAll('d1');
    expect(
      (fields.accept.mock.calls as Array<[unknown, number]>).map(([, index]) => index),
    ).toEqual([1]);
    // Перегенерация видна у пункта (`regenerating`): в пропущенных его нет.
    expect(answer.skipped).toEqual([]);
    const building = setup(rowOf([item('themes')], 'building'));
    const error = await building.service.acceptAll('d1').catch((e: unknown) => e);
    expect(codeOf(error)).toBe('ANALYSIS_WRITE_NOT_READY');
  });
});

describe('AnalysisWriteService: the item routes (F07-1b)', () => {
  it('a row of another kind or none - 404; a block that does not exist - 400 ANALYSIS_ITEM_UNKNOWN', async () => {
    const other = setup({ ...rowOf([item('themes')]), kind: 'summary_write' });
    await expect(other.service.accept('d1', 0)).rejects.toBeInstanceOf(NotFoundException);
    // GET items/:index: у хода пересказа своей ручки содержимого нет - 404 той же выборкой.
    await expect(other.service.proposal('d1', 0)).rejects.toBeInstanceOf(NotFoundException);
    const none = setup(null);
    await expect(none.service.discard('d1')).rejects.toBeInstanceOf(NotFoundException);
    const { service } = setup(rowOf([item('themes')]));
    const error: unknown = await service.accept('d1', 5).catch((e: unknown) => e);
    expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
      'ANALYSIS_ITEM_UNKNOWN',
    );
  });

  it('accept and discard of a block go to the fields; a regenerating block is 409', async () => {
    const { service, fields } = setup(rowOf([item('characters')]));
    await service.accept('d1', 0);
    await service.discardItem('d1', 0);
    const row = rowOf([item('characters')]);
    expect(fields.accept).toHaveBeenCalledTimes(1);
    expect(fields.accept).toHaveBeenCalledWith(row, 0);
    expect(fields.discardItem).toHaveBeenCalledTimes(1);
    expect(fields.discardItem).toHaveBeenCalledWith(row, 0);
    const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
    const busy = setup(rowOf([item('characters', { regen })]));
    expect(codeOf(await busy.service.accept('d1', 0).catch((e: unknown) => e))).toBe(
      'ANALYSIS_REGEN_IN_PROGRESS',
    );
  });
});

describe('AnalysisWriteService.regenerate (F07-1b)', () => {
  it('theme links and sources are not regenerated on their own - 409 (F07-2b)', async () => {
    const links = setup(rowOf([item('characters', { links: true })]));
    expect(
      codeOf(await links.service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e)),
    ).toBe('ANALYSIS_ITEM_NOT_REGENERABLE');
    const sources = setup(rowOf([item('sources', { step: 5 })]));
    expect(
      codeOf(await sources.service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e)),
    ).toBe('ANALYSIS_ITEM_NOT_REGENERABLE');
  });

  it('every block of steps 3-5 passes the gate of regeneration (decision F07 | F07-1b)', async () => {
    const later: Array<[AnalysisTarget, 3 | 4 | 5]> = [
      ['mainIdea', 3],
      ['themes', 3],
      ['symbols', 3],
      ['titleMeaning', 3],
      ['endingMeaning', 3],
      ['misreadings', 4],
      ['discussionQuestions', 4],
      ['faq', 4],
      ['facts.genre', 5],
      ['facts.movement', 5],
      ['facts.writtenYears', 5],
      ['context', 5],
      ['timeline', 5],
      ['reception', 5],
      ['adaptations', 5],
    ];
    for (const [target, step] of later) {
      const run = setup(rowOf([item(target, { step })]));
      jest.spyOn(run.internals, 'regenUsd').mockResolvedValue(new Prisma.Decimal('0.1'));
      // Потолок трат - первая проверка после допуска блока: дошли до неё - блок допущен.
      run.budget.ceilingReached.mockResolvedValue(true);
      const error = await run.service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e);
      expect([target, codeOf(error)]).toEqual([target, 'LLM_CEILING_REACHED']);
    }
  });

  it('a second regeneration of the same block - 409 ANALYSIS_REGEN_IN_PROGRESS; a run that is not ready - 409', async () => {
    const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
    const busy = setup(rowOf([item('characters', { regen })]));
    expect(
      codeOf(await busy.service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e)),
    ).toBe('ANALYSIS_REGEN_IN_PROGRESS');
    const building = setup(rowOf([item('characters')], 'building'));
    expect(
      codeOf(await building.service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e)),
    ).toBe('ANALYSIS_WRITE_NOT_READY');
  });

  it('the spending ceiling - 409 before any operation is created', async () => {
    const { service, internals, budget, fields } = setup(rowOf([item('characters')]));
    jest.spyOn(internals, 'regenUsd').mockResolvedValue(new Prisma.Decimal('0.1'));
    budget.ceilingReached.mockResolvedValue(true);
    expect(codeOf(await service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e))).toBe(
      'LLM_CEILING_REACHED',
    );
    expect(fields.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['characters', 1],
    ['themes', 3],
    ['faq', 4],
    ['context', 5],
  ] as Array<[AnalysisTarget, 1 | 3 | 4 | 5]>)(
    '%s (step %s): own operation and task with the index and the remark of the editor; the mark sits on the block',
    async (target, step) => {
      const { service, internals, fields, tx, tasks, llm } = setup(rowOf([item(target, { step })]));
      jest.spyOn(internals, 'regenUsd').mockResolvedValue(new Prisma.Decimal('0.1'));
      fields.mutate.mockImplementation(
        async (
          _row: unknown,
          _gate: unknown,
          fn: (data: unknown, client: typeof tx) => Promise<{ items: AnalysisItem[] }>,
        ) => {
          const data = { ...emptyAnalysisData({}, {}), items: [item(target, { step })] };
          return { data: await fn(data, tx), written: true };
        },
      );
      await service.regenerate('d1', 0, 'shorter', 'u1');
      expect(llm.operationData).toHaveBeenCalledTimes(1);
      expect(tasks.enqueue).toHaveBeenCalledTimes(1);
      expect(llm.operationData).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'draft', bookVersionId: 'v1', createdById: 'u1' }),
      );
      expect(tasks.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'analysis_write',
          operationId: 'op-new',
          payload: { draftId: 'd1', index: 0 },
          pairKey: 'op-new:d1:0',
        }),
        tx,
      );
      const next = (await fields.mutate.mock.results[0].value) as {
        data: { items: AnalysisItem[] };
      };
      expect(next.data.items[0].regen).toEqual({
        operationId: 'op-new',
        remark: 'shorter',
        pending: null,
        previous: null,
      });
    },
  );

  it('the run changed under the lock (the mark was set by a parallel call): 409, no second operation', async () => {
    const { service, internals, fields, tx } = setup(rowOf([item('characters')]));
    jest.spyOn(internals, 'regenUsd').mockResolvedValue(new Prisma.Decimal('0.1'));
    fields.mutate.mockImplementation(
      async (_row: unknown, _gate: unknown, fn: (data: unknown, client: typeof tx) => unknown) => {
        const regen = { operationId: 'op2', remark: null, pending: null, previous: null };
        await fn({ ...emptyAnalysisData({}, {}), items: [item('characters', { regen })] }, tx);
        return null;
      },
    );
    const error = await service.regenerate('d1', 0, null, 'u1').catch((e: unknown) => e);
    expect(codeOf(error)).toBe('ANALYSIS_REGEN_IN_PROGRESS');
    expect(tx.llmOperation.create).not.toHaveBeenCalled();
  });
});

describe('AnalysisWriteService.discard (discard-run, F07-1b; /fix 2 blocker 2)', () => {
  const regen = (operationId: string) => ({
    operationId,
    remark: null,
    pending: null,
    previous: null,
  });

  /** Журнал отмены: операции (своими транзакциями) и итоговая транзакция строки - по порядку. */
  function discardLog(s: ReturnType<typeof setup>, finals: Array<ReturnType<typeof rowOf>>) {
    const log: string[] = [];
    s.tasks.cancelOperation.mockImplementation((id: string, fn: (t: unknown) => Promise<void>) => {
      log.push(`cancel ${id}`);
      return fn({
        contentDraft: {
          updateMany: () => {
            log.push(`  building→discarded under ${id}`);
            return Promise.resolve({ count: 1 });
          },
        },
      }).then(() => true);
    });
    s.handler.clearRegenMark.mockImplementation((id: string) => {
      log.push(`  clear mark of ${id}`);
      return Promise.resolve();
    });
    const tx = s.tx as unknown as Record<string, unknown>;
    tx.$queryRaw = jest.fn((strings: TemplateStringsArray) => {
      log.push(strings.join('?').includes('pg_advisory_xact_lock') ? 'lock analysis' : 'lock row');
      return Promise.resolve([]);
    });
    const findUnique = jest.fn();
    for (const row of finals) findUnique.mockResolvedValueOnce(row);
    const updateMany = jest.fn(() => {
      log.push('discarded');
      return Promise.resolve({ count: 1 });
    });
    tx.contentDraft = { findUnique, updateMany };
    return { log, updateMany };
  }

  it('the operations are stopped before the analysis lock and the row (the order of stopOperation): regenerations clearing their marks, then the run; then the row is discarded', async () => {
    const row = rowOf([item('characters', { regen: regen('op2') })], 'building');
    const s = setup(row);
    const { log } = discardLog(s, [rowOf([item('characters')], 'discarded')]);
    await s.service.discard('d1');
    expect(log).toEqual([
      'cancel op2',
      '  clear mark of op2',
      'cancel op1',
      '  building→discarded under op1',
      'lock analysis',
      'lock row',
      'discarded',
    ]);
    expect(s.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(s.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      BOOK_ANALYSIS_TX_OPTIONS,
    );
  });

  it('a regeneration started between the read and the lock: the row is not discarded under the lock, the next pass stops it in the same order', async () => {
    const started = rowOf([item('characters', { regen: regen('op3') })]);
    const s = setup(rowOf([item('characters')]));
    s.prisma.contentDraft.findUnique
      .mockResolvedValueOnce(rowOf([item('characters')]))
      .mockResolvedValueOnce(started);
    const { log } = discardLog(s, [started, rowOf([item('characters')])]);
    await s.service.discard('d1');
    expect(log).toEqual([
      'lock analysis',
      'lock row',
      'cancel op3',
      '  clear mark of op3',
      'lock analysis',
      'lock row',
      'discarded',
    ]);
  });

  it('a ready run: no operation is stopped; an already discarded run - nothing at all; a regeneration that keeps starting - 409 after the attempts', async () => {
    const s = setup(rowOf([item('characters')]));
    const { log } = discardLog(s, [rowOf([item('characters')])]);
    await s.service.discard('d1');
    expect(log).toEqual(['lock analysis', 'lock row', 'discarded']);
    expect(s.tasks.cancelOperation).not.toHaveBeenCalled();
    expect(s.fields.accept).not.toHaveBeenCalled();

    const gone = setup(rowOf([item('characters')], 'discarded'));
    await gone.service.discard('d1');
    expect(gone.prisma.$transaction).not.toHaveBeenCalled();

    const busy = rowOf([item('characters', { regen: regen('op4') })]);
    const b = setup(busy);
    discardLog(b, [busy, busy, busy]);
    expect(codeOf(await b.service.discard('d1').catch((e: unknown) => e))).toBe(
      'ANALYSIS_REGEN_IN_PROGRESS',
    );
  });
});

/** Блоки шагов 4-5 в содержимом предложения: пусты, пока предложение не про них (`F07-2a`). */
const NO_LATER_BLOCKS = {
  misreadings: null,
  discussionQuestions: null,
  faq: null,
  timeline: null,
  adaptations: null,
  sources: null,
};

describe('the content of a proposal (F07-1b, decision А: GET items/:index, not the run answer)', () => {
  const runRow = (items: AnalysisItem[]) => ({
    ...rowOf(items),
    operation: {
      id: 'op1',
      kind: 'draft',
      status: 'done',
      pauseReason: null,
      bookVersionId: 'v1',
      limitUsd: new Prisma.Decimal(1),
      reservedUsd: new Prisma.Decimal(0),
      spentUsd: new Prisma.Decimal(0),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    waitingFor: null,
    failedReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('the run answer carries no content of the blocks, a proposal included', async () => {
    const items = [item('characters', { value: [{ key: 'anna' }] })];
    const { service, prisma } = setup(rowOf(items));
    (service.get as jest.Mock).mockRestore();
    prisma.contentDraft.findUnique.mockResolvedValue(runRow(items));
    const [answer] = (await service.get('d1')).items;
    expect(answer.outcome).toBe('proposed');
    expect(answer).not.toHaveProperty('value');
  });

  it('a proposal: its content in the one field of its block kind, the others null', async () => {
    const { service } = setup(
      rowOf([
        item('characters', { value: [{ key: 'anna' }] }),
        item('facts.narrator', { value: 'Third person' }),
      ]),
    );
    await expect(service.proposal('d1', 0)).resolves.toEqual({
      text: null,
      characters: [{ key: 'anna' }],
      keyQuotes: null,
      style: null,
      themes: null,
      symbols: null,
      ...NO_LATER_BLOCKS,
    });
    await expect(service.proposal('d1', 1)).resolves.toEqual({
      text: 'Third person',
      characters: null,
      keyQuotes: null,
      style: null,
      themes: null,
      symbols: null,
      ...NO_LATER_BLOCKS,
    });
  });

  it('not a proposal or a value of the wrong form - 409 ANALYSIS_ITEM_NOT_PROPOSED; an unknown block - 400; a run that is not ready - 409', async () => {
    const { service } = setup(
      rowOf([
        item('characters', { outcome: 'written', value: [{ key: 'anna' }] }),
        item('characters', { outcome: 'accepted', value: [{ key: 'anna' }] }),
        item('characters', { value: 'text instead of a list' }),
        item('mainIdea', { value: [{ key: 'list instead of a text' }] }),
        item('themes', { value: null }),
      ]),
    );
    for (const index of [0, 1, 2, 3, 4]) {
      expect(codeOf(await service.proposal('d1', index).catch((e: unknown) => e))).toBe(
        'ANALYSIS_ITEM_NOT_PROPOSED',
      );
    }
    const unknown: unknown = await service.proposal('d1', 9).catch((e: unknown) => e);
    expect((unknown as { getResponse: () => { code: string } }).getResponse().code).toBe(
      'ANALYSIS_ITEM_UNKNOWN',
    );
    const building = setup(rowOf([item('characters', { value: [] })], 'building'));
    expect(codeOf(await building.service.proposal('d1', 0).catch((e: unknown) => e))).toBe(
      'ANALYSIS_WRITE_NOT_READY',
    );
  });
});
