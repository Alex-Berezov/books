import { Prisma } from '@prisma/client';
import { newRetry, retryOf, retryOpen, retryStepChunk, retryStore } from './chunk-retry';
import { PrismaService } from '../../../prisma/prisma.service';

/** Строка куска в «базе»: попытка под замком и её запись, как у транзакции на подмене. */
function fakeDb(retry: unknown) {
  const stored = { retry };
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ retry: stored.retry }])),
    translationChunk: {
      update: jest.fn((args: { data: { retry: unknown } }) => {
        stored.retry = args.data.retry;
        return Promise.resolve({});
      }),
    },
  };
  const db = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  return { db, stored, tx };
}

describe('chunk retry attempt (F05-7v)', () => {
  it('reads only an attempt of its form; open while translating or checking', () => {
    expect(retryOf(null)).toBeNull();
    expect(retryOf({ operationId: 'op', status: 'pending' })).toBeNull();
    const fresh = newRetry('op', 'm/x');
    expect(retryOf(fresh as unknown as Prisma.JsonValue)).toEqual(fresh);
    expect(retryOpen(fresh)).toBe(true);
    expect(retryOpen({ ...fresh, status: 'applied' })).toBe(false);
    expect(retryOpen({ ...fresh, status: 'failed' })).toBe(false);
    expect(retryOpen(null)).toBe(false);
  });

  it('the step chunk takes the bounds of the row and the translation of the attempt', () => {
    const chunk = retryStepChunk(
      { id: 'c', chunkIndex: 1, firstBlock: 3, lastBlock: 5, words: 10 },
      {
        ...newRetry('op', null),
        status: 'translated',
        blocks: [{ n: 3, text: 'x' }],
        costUsd: '0.5',
      },
    );
    expect(chunk).toMatchObject({ id: 'c', firstBlock: 3, status: 'translated', model: null });
    expect(chunk.costUsd?.toString()).toBe('0.5');
  });

  it('a write adds the cost and the attempt, only to the attempt of its operation and status', async () => {
    const { db, stored } = fakeDb(newRetry('op', null));
    const store = retryStore(db, 'c', 'op');
    await store.write('pending', {
      status: 'translated',
      blocks: [{ n: 1, text: 'uno' }],
      costUsd: new Prisma.Decimal('0.25'),
      attempt: true,
      model: 'm/a',
    });
    expect(stored.retry).toMatchObject({
      status: 'translated',
      costUsd: '0.25',
      attempts: 1,
      model: 'm/a',
    });
    // Не тот статус (повтор шага после потерянной аренды) - ничего не пишется.
    await store.write('pending', { costUsd: new Prisma.Decimal('1') });
    expect(stored.retry).toMatchObject({ costUsd: '0.25' });
    // Чужая операция (попытку заменил новый повтор) - тоже.
    await retryStore(db, 'c', 'other').write('translated', { status: 'checked' });
    expect(stored.retry).toMatchObject({ status: 'translated' });
  });

  it('a translate flag drops the text of an earlier attempt: the piece is not replaced by it', async () => {
    const { db, stored } = fakeDb({
      ...newRetry('op', null),
      status: 'pending',
      blocks: [{ n: 1, text: 'failed check' }],
      rawResponse: { blocks: [] },
    });
    await retryStore(db, 'c', 'op').flag('pending', 'CHUNK_INVALID_RESPONSE', {
      costUsd: new Prisma.Decimal('0.1'),
      attempt: true,
    });
    expect(stored.retry).toMatchObject({ status: 'flagged', flagReason: 'CHUNK_INVALID_RESPONSE' });
    expect(stored.retry).not.toHaveProperty('blocks');
    expect(stored.retry).not.toHaveProperty('rawResponse');
  });

  it('a check flag keeps the new translation: it replaces the piece with the flag', async () => {
    const { db, stored } = fakeDb({
      ...newRetry('op', null),
      status: 'translated',
      blocks: [{ n: 1, text: 'new' }],
    });
    await retryStore(db, 'c', 'op').flag('translated', 'NOT_INDEPENDENT', {});
    expect(stored.retry).toMatchObject({ status: 'flagged', blocks: [{ n: 1, text: 'new' }] });
  });
});
