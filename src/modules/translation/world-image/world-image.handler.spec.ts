import { LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../../shared/storage/storage.interface';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { WorldImageHandler } from './world-image.handler';
import { LockedImageRow } from './world-image.service';

/** Заголовок PNG с `IHDR`: проверке картинки больше не нужно. */
function png(width: number, height: number): string {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

const TASK = {
  id: 't-1',
  operationId: 'op-1',
  bookVersionId: 'v-1',
  payload: { key: 'oblomov' },
} as unknown as LlmTask;

const ENTITY = {
  type: 'character',
  role: 'main',
  blocks: { appearance: 'A plump man in a dressing gown.' },
  bookVersion: {
    bookId: 'book-1',
    analyses: [{ facts: { settingPlace: 'St Petersburg', settingTime: '1840s' } }],
  },
};

const CTX = {
  callOptions: { beforeAttempt: jest.fn(), signal: new AbortController().signal, taskId: 't-1' },
} as unknown as LlmTaskContext;

describe('WorldImageHandler (F08-11a)', () => {
  let locked: LockedImageRow;
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    mediaAsset: { create: jest.Mock };
    bookWorldImage: { update: jest.Mock };
  };
  let prisma: { bookWorldEntity: { findUnique: jest.Mock } };
  let llm: { callImageStage: jest.Mock };
  let tasks: { completeOperation: jest.Mock; failOperation: jest.Mock };
  let storage: { save: jest.Mock; delete: jest.Mock; getPublicUrl: jest.Mock };
  let handler: WorldImageHandler;
  let opActive: boolean;

  const answer = (base64: unknown, oversize = false) =>
    llm.callImageStage.mockResolvedValue({
      callId: 'c-1',
      model: 'a/image',
      base64,
      oversize,
      costUsd: new Prisma.Decimal('0.04'),
    });

  beforeEach(() => {
    opActive = true;
    locked = {
      id: 'img-1',
      operationId: 'op-1',
      pendingMediaId: null,
      pendingDeleted: null,
      operationStatus: 'active',
      operationRunning: true,
    };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(() => Promise.resolve([locked])),
      mediaAsset: { create: jest.fn().mockResolvedValue({ id: 'm-new' }) },
      bookWorldImage: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = { bookWorldEntity: { findUnique: jest.fn().mockResolvedValue(ENTITY) } };
    llm = { callImageStage: jest.fn() };
    tasks = {
      completeOperation: jest.fn(async (_id: string, after: (t: typeof tx) => Promise<void>) => {
        if (!opActive) return false;
        await after(tx);
        return true;
      }),
      failOperation: jest.fn().mockResolvedValue(true),
    };
    storage = {
      save: jest.fn().mockResolvedValue('ok'),
      delete: jest.fn().mockResolvedValue(undefined),
      getPublicUrl: jest.fn((k: string) => `https://media/${k}`),
    };
    handler = new WorldImageHandler(
      prisma as unknown as PrismaService,
      llm as unknown as LlmService,
      tasks as unknown as LlmTaskService,
      storage as unknown as StorageService,
    );
    answer(png(1536, 1536));
  });

  const run = () => handler.handler.run(TASK, CTX);

  it('a valid PNG: file stored, MediaAsset and pending cell in the completion transaction', async () => {
    await expect(run()).resolves.toEqual({ kind: 'done' });

    expect(llm.callImageStage).toHaveBeenCalledTimes(1);
    const [operationId, stage, prompt, image, options] = llm.callImageStage.mock.calls[0] as [
      string,
      string,
      string,
      { aspectRatio: string },
      unknown,
    ];
    expect([operationId, stage, image.aspectRatio, options]).toEqual([
      'op-1',
      'world_image',
      '1:1',
      CTX.callOptions,
    ]);
    expect(prompt).toContain('dressing gown');
    expect(prompt).toContain('St Petersburg; 1840s');

    expect(storage.save).toHaveBeenCalledTimes(1);
    const [key, bytes, opts] = storage.save.mock.calls[0] as [string, Buffer, unknown];
    expect(key).toMatch(/^illustrations\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\.png$/);
    expect(bytes).toBeInstanceOf(Buffer);
    expect(opts).toEqual({ contentType: 'image/png' });

    expect(tx.mediaAsset.create).toHaveBeenCalledTimes(1);
    expect(tx.mediaAsset.create).toHaveBeenCalledWith({
      data: {
        key,
        url: `https://media/${key}`,
        contentType: 'image/png',
        size: bytes.length,
        width: 1536,
        height: 1536,
      },
      select: { id: true },
    });
    expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
    expect(tx.bookWorldImage.update).toHaveBeenCalledWith({
      where: { id: 'img-1' },
      data: { pendingMediaId: 'm-new' },
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(tasks.failOperation).not.toHaveBeenCalled();
  });

  it('the row is led by another generation: the cell is not touched, no MediaAsset, the file is removed', async () => {
    locked = { ...locked, operationId: 'op-2' };
    await expect(run()).resolves.toEqual({ kind: 'done' });
    expect(tx.mediaAsset.create).not.toHaveBeenCalled();
    expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(storage.save.mock.calls[0][0]);
  });

  it('the completion transaction throws: the file is removed and the failure goes up', async () => {
    const broken = new Error('connection lost');
    tasks.completeOperation.mockRejectedValue(broken);
    await expect(run()).rejects.toBe(broken);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(storage.save.mock.calls[0][0]);
  });

  it('the transaction throws after the cell was written (rolled back): the file is still removed', async () => {
    const broken = new Error('commit failed');
    tasks.completeOperation.mockImplementation(
      async (_id: string, after: (t: typeof tx) => Promise<void>) => {
        await after(tx);
        throw broken;
      },
    );
    await expect(run()).rejects.toBe(broken);
    expect(tx.mediaAsset.create).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('the operation was stopped meanwhile: nothing is written, the file is removed', async () => {
    opActive = false;
    await run();
    expect(tx.mediaAsset.create).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an SVG',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      false,
      'WORLD_IMAGE_NOT_IMAGE',
    ],
    ['a 1024 px image', png(1024, 1024), false, 'WORLD_IMAGE_TOO_SMALL'],
    ['no image', null, false, 'WORLD_IMAGE_NOT_IMAGE'],
    ['a body over the limit', null, true, 'WORLD_IMAGE_TOO_LARGE'],
  ])(
    '%s: the operation fails with its reason, nothing is stored',
    async (_, base64, oversize, reason) => {
      answer(base64, oversize);
      await expect(run()).resolves.toEqual({ kind: 'fail', reason });
      expect(tasks.failOperation).toHaveBeenCalledTimes(1);
      expect(tasks.failOperation).toHaveBeenCalledWith('op-1');
      expect(storage.save).not.toHaveBeenCalled();
      expect(tasks.completeOperation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['the entity is gone', null],
    ['it is no longer a main or secondary character', { ...ENTITY, role: 'minor' }],
    ['its appearance text is gone', { ...ENTITY, blocks: {} }],
  ])('%s: WORLD_IMAGE_INPUT_MISSING without calling the model', async (_, entity) => {
    prisma.bookWorldEntity.findUnique.mockResolvedValue(entity);
    await expect(run()).resolves.toEqual({ kind: 'fail', reason: 'WORLD_IMAGE_INPUT_MISSING' });
    expect(llm.callImageStage).not.toHaveBeenCalled();
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
  });

  it('onFailed (money, provider, attempts) closes the operation as failed', async () => {
    await handler.handler.onFailed?.(TASK, 'LLM_INSUFFICIENT_FUNDS');
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).toHaveBeenCalledWith('op-1');
  });
});
