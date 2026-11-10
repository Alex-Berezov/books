import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { acceptInTurn, regenOperationIds, regenResumeOf } from './run-regen';

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
