import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LlmTask, Prisma } from '@prisma/client';
import {
  acceptInTurn,
  cancelRegens,
  discardPrevious,
  draftRowOf,
  PREVIOUS_BATCH,
  regenOperationIds,
  regenResumeOf,
  waitingAndRegens,
} from './run-regen';

/**
 * «Accept all» по одному (`F06-2`, `F07-1b`): 409 несёт `acceptedIndexes` у обоих ходов; прочие
 * отказы ручки - только у хода анализа (`anyHttp`), у пересказа 400 и 404 уходят как были (решение
 * арбитра `F07 | F07-1b` по /fix 1, п.6; контракт `api-contracts.md` - `acceptedIndexes` в 409).
 */

const order = (indexes: number[]) => (accepted: readonly number[]) =>
  indexes[accepted.length] ?? null;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('no refusal');
    },
    (e: unknown) => e,
  );
}

describe('acceptInTurn', () => {
  it('409 carries what is already written, the same class - for the summary run (default) too', async () => {
    const accept = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ConflictException({ code: 'C' }));
    const error = await failure(acceptInTurn(order([4, 7]), accept));
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'C',
      acceptedIndexes: [4],
      stoppedIndex: 7,
    });
  });

  it('the default (summary): 400 and 404 come out as they were - the same object, no acceptedIndexes', async () => {
    for (const refusal of [new BadRequestException({ code: 'B' }), new NotFoundException('gone')]) {
      const accept = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal);
      await expect(acceptInTurn(order([0, 1]), accept)).rejects.toBe(refusal);
    }
  });

  it('anyHttp (analysis): 400 keeps its status and body and gets acceptedIndexes; a plain error comes out as it is', async () => {
    const accept = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BadRequestException({ code: 'B' }));
    const error = (await failure(
      acceptInTurn(order([2, 3]), accept, { anyHttp: true }),
    )) as BadRequestException;
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({ code: 'B', acceptedIndexes: [2], stoppedIndex: 3 });
    const boom = new Error('db');
    await expect(
      acceptInTurn(order([1]), jest.fn().mockRejectedValue(boom), { anyHttp: true }),
    ).rejects.toBe(boom);
  });

  it('a skipped proposal (false) is not counted as written and the pass goes on', async () => {
    const seen: number[] = [];
    const accept = jest.fn((index: number) => {
      seen.push(index);
      return Promise.resolve(index !== 1);
    });
    const skipped = new Set<number>();
    const next = (accepted: readonly number[]) =>
      [0, 1, 2].find((i) => !accepted.includes(i) && !skipped.has(i) && !seen.includes(i)) ?? null;
    await expect(acceptInTurn(next, accept)).resolves.toEqual([0, 2]);
    expect(accept).toHaveBeenCalledTimes(3);
  });
});

describe('regenOperationIds', () => {
  it('lists only the items with a regeneration mark', () => {
    expect(
      regenOperationIds([
        { regen: { operationId: 'a' } },
        { regen: null },
        { regen: { operationId: 'b' } },
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('regenResumeOf (T177)', () => {
  const row = { id: 'd1', bookVersionId: 'v1', language: 'en' };
  const prisma = (found: unknown[]) =>
    ({
      $queryRaw: jest.fn().mockResolvedValue(found),
      contentDraft: { findUnique: jest.fn().mockResolvedValue({ ...row, data: {} }) },
    }) as never;

  it('builds the task by the handler own task input, not by the kind of the row', async () => {
    const taskOf = jest.fn().mockReturnValue({ kind: 'task-kind-of-the-handler' });
    const tasks = await regenResumeOf(
      prisma([{ id: 'd1', bookVersionId: 'v1' }]),
      'summary_write',
      { id: 'op1' },
      () => [{ regen: null }, { regen: { operationId: 'op1' } }],
      taskOf,
    );
    expect(taskOf).toHaveBeenCalledTimes(1);
    expect(taskOf).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), 'op1', 1);
    expect(tasks).toEqual([{ kind: 'task-kind-of-the-handler' }]);
  });

  it('no row with the mark - no task', async () => {
    const taskOf = jest.fn();
    expect(
      await regenResumeOf(prisma([]), 'summary_write', { id: 'op1' }, () => [], taskOf),
    ).toEqual([]);
    expect(taskOf).not.toHaveBeenCalled();
  });
});

describe('draftRowOf', () => {
  it('no draft id in the payload - null without a query; with it - one read by id', async () => {
    const findUnique = jest.fn();
    const db = { contentDraft: { findUnique } } as never;
    expect(await draftRowOf(db, { payload: {} } as unknown as LlmTask)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    findUnique.mockResolvedValue({ id: 'd1' });
    expect(await draftRowOf(db, { payload: { draftId: 'd1' } } as unknown as LlmTask)).toEqual({
      id: 'd1',
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'd1' } });
  });
});

describe('cancelRegens', () => {
  it('each operation - its own cancel, the mark of that operation cleared in its transaction', async () => {
    const txs: object[] = [];
    const cancelOperation = jest.fn(async (_id: string, fn: (tx: never) => Promise<void>) => {
      const tx = {};
      txs.push(tx);
      await fn(tx as never);
    });
    const clearRegenMark = jest.fn().mockResolvedValue(undefined);
    await cancelRegens({ cancelOperation } as never, { clearRegenMark }, ['a', 'b']);
    expect(cancelOperation.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(clearRegenMark.mock.calls).toEqual([
      ['a', txs[0]],
      ['b', txs[1]],
    ]);
  });
});

describe('waitingAndRegens', () => {
  function fakeDb(glossary: object | null) {
    return {
      bookGlossary: { findUnique: jest.fn().mockResolvedValue(glossary) },
      llmOperation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r1', status: 'paused', pauseReason: 'X' }]),
      },
    };
  }

  it('building and waiting for a glossary row - glossary; another row - dossier', async () => {
    const db = fakeDb({ id: 'g' });
    const row = { waitingFor: 'g', status: 'building' } as never;
    const result = await waitingAndRegens(db as never, row, ['r1']);
    expect(result.waitingFor).toBe('glossary');
    expect(db.bookGlossary.findUnique).toHaveBeenCalledTimes(1);
    expect(db.bookGlossary.findUnique).toHaveBeenCalledWith({
      where: { id: 'g' },
      select: { id: true },
    });
    expect(db.llmOperation.findMany).toHaveBeenCalledTimes(1);
    expect(db.llmOperation.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] } },
      select: { id: true, status: true, pauseReason: true },
    });
    expect([...result.regenOps.keys()]).toEqual(['r1']);
    expect((await waitingAndRegens(fakeDb(null) as never, row, [])).waitingFor).toBe('dossier');
  });

  it('not building or nothing awaited - null without reading the glossary; no regenerations - no query', async () => {
    for (const row of [
      { waitingFor: 'g', status: 'ready' },
      { waitingFor: null, status: 'building' },
    ]) {
      const db = fakeDb({ id: 'g' });
      const result = await waitingAndRegens(db as never, row as never, []);
      expect(result.waitingFor).toBeNull();
      expect(result.regenOps.size).toBe(0);
      expect(db.bookGlossary.findUnique).not.toHaveBeenCalled();
      expect(db.llmOperation.findMany).not.toHaveBeenCalled();
    }
  });
});

describe('discardPrevious (T191, LEGACY-498)', () => {
  const page = (from: number, count: number, ops: Record<number, unknown[]> = {}) =>
    Array.from({ length: count }, (_, n) => ({
      id: `r${String(from + n).padStart(4, '0')}`,
      operationIds: ops[from + n] ?? [],
    }));

  function txWith(pages: Array<Array<{ id: string; operationIds: unknown }>>) {
    const reads: unknown[][] = [];
    const tx = {
      $queryRaw: jest.fn((_: TemplateStringsArray, ...values: unknown[]) => {
        reads.push(values);
        return Promise.resolve(pages[reads.length - 1] ?? []);
      }),
      contentDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, reads };
  }

  it.each(['summary_write', 'analysis_write'] as const)(
    '%s: more than one page of previous runs - all pages read, all discarded, every regeneration returned once',
    async (kind) => {
      const { tx, raw, reads } = txWith([
        page(0, PREVIOUS_BATCH, { 0: ['op-a'], 1: ['op-a', 5] }),
        page(PREVIOUS_BATCH, 3, { [PREVIOUS_BATCH + 2]: ['op-b'] }),
      ]);
      const stale = await discardPrevious(tx, 'v1', kind);
      expect(stale).toEqual(['op-a', 'op-b']);
      expect(reads).toHaveLength(2);
      expect(reads[0]).toEqual(expect.arrayContaining(['v1', kind]));
      // Первая порция - без курсора (пустой фрагмент), вторая - после последнего id первой.
      expect(reads[0]).toContainEqual(expect.objectContaining({ values: [] }));
      expect(reads[1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            strings: ['AND "id" > ', ''],
            values: [`r${String(PREVIOUS_BATCH - 1).padStart(4, '0')}`],
          }),
        ]),
      );
      expect(raw.contentDraft.updateMany).toHaveBeenCalledTimes(1);
      expect(raw.contentDraft.updateMany).toHaveBeenCalledWith({
        where: { bookVersionId: 'v1', kind, status: { in: ['ready', 'failed'] } },
        data: { status: 'discarded' },
      });
    },
  );

  it('a full last page is followed by one more read that finds nothing', async () => {
    const { tx, raw, reads } = txWith([page(0, PREVIOUS_BATCH), []]);
    expect(await discardPrevious(tx, 'v1', 'summary_write')).toEqual([]);
    expect(reads).toHaveLength(2);
    expect(raw.contentDraft.updateMany).toHaveBeenCalledTimes(1);
  });
});
