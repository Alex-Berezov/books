import { failRun, finishRun, stepGone } from './run-steps';

/** Концы шага хода пересказа и анализа (`T178`): одна запись строки и одна операция на конец. */

const row = { id: 'd1', operationId: 'op1' } as never;

function fakeTasks() {
  const updateMany = jest.fn();
  const tx = { contentDraft: { updateMany } };
  const run = async (_id: string, fn?: (t: typeof tx) => Promise<void>) => fn?.(tx);
  return {
    updateMany,
    tasks: {
      completeOperation: jest.fn(run),
      failOperation: jest.fn(run),
    },
  };
}

describe('run steps', () => {
  it('stepGone closes the operation and writes no row', async () => {
    const { tasks, updateMany } = fakeTasks();
    expect(await stepGone(tasks as never, 'op1')).toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation).toHaveBeenCalledWith('op1');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('finishRun: one write - ready for the building row of this operation', async () => {
    const { tasks, updateMany } = fakeTasks();
    expect(await finishRun(tasks as never, row)).toEqual({ kind: 'done' });
    expect(tasks.completeOperation).toHaveBeenCalledTimes(1);
    expect(tasks.completeOperation.mock.calls[0][0]).toBe('op1');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building', operationId: 'op1' },
      data: { status: 'ready', waitingFor: null },
    });
  });

  it('failRun: the operation of the row fails, the reason is written once', async () => {
    const { tasks, updateMany } = fakeTasks();
    expect(await failRun(tasks as never, row, 'WHY')).toEqual({ kind: 'done' });
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation.mock.calls[0][0]).toBe('op1');
    expect(tasks.completeOperation).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'building' },
      data: { status: 'failed', failedReason: 'WHY' },
    });
  });
});
