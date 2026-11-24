import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { DRAFT_TX_OPTIONS } from '../content-draft/content-draft.constants';
import { LockedImageRow, WorldImageService } from './world-image.service';

const D = (v: string) => new Prisma.Decimal(v);

const codeOf = (error: unknown): unknown =>
  error instanceof HttpException ? (error.getResponse() as { code?: unknown }).code : undefined;

const ENTITY = {
  type: 'character',
  role: 'main',
  blocks: { appearance: 'A plump man in a dressing gown.' },
  bookVersion: { bookId: 'book-1' },
};

const LOCKED: LockedImageRow = {
  id: 'img-1',
  operationId: null,
  pendingMediaId: null,
  pendingDeleted: null,
  operationStatus: null,
  operationRunning: false,
};

describe('WorldImageService (F08-11a)', () => {
  let locked: LockedImageRow;
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    llmOperation: { create: jest.Mock; updateMany: jest.Mock };
    llmTask: { updateMany: jest.Mock };
    bookWorldImage: { update: jest.Mock };
  };
  let prisma: {
    bookWorldEntity: { findUnique: jest.Mock };
    bookWorldImage: { findUnique: jest.Mock };
    llmTask: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let llm: { assertEnabled: jest.Mock; operationData: jest.Mock; getStageSetting: jest.Mock };
  let budget: { ceilingReached: jest.Mock };
  let tasks: { enqueue: jest.Mock };
  let service: WorldImageService;

  beforeEach(() => {
    locked = { ...LOCKED };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(() => Promise.resolve([locked])),
      llmOperation: {
        create: jest.fn().mockResolvedValue({ id: 'op-new' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      llmTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      bookWorldImage: { update: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      bookWorldEntity: { findUnique: jest.fn().mockResolvedValue(ENTITY) },
      bookWorldImage: { findUnique: jest.fn().mockResolvedValue(null) },
      llmTask: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    llm = {
      assertEnabled: jest.fn(),
      operationData: jest.fn().mockResolvedValue({ kind: 'draft' }),
      getStageSetting: jest.fn().mockResolvedValue({ fallbacks: [] }),
    };
    budget = { ceilingReached: jest.fn().mockResolvedValue(false) };
    tasks = { enqueue: jest.fn().mockResolvedValue({ created: true, task: {} }) };
    service = new WorldImageService(
      prisma as unknown as PrismaService,
      llm as unknown as LlmService,
      budget as unknown as LlmBudgetService,
      tasks as unknown as LlmTaskService,
    );
  });

  describe('generate', () => {
    const generate = () => service.generate('v-1', 'oblomov', 'admin-1');

    it('one draft operation with the limit for the primary and every fallback, one task of its own pair, in one transaction', async () => {
      llm.getStageSetting.mockResolvedValue({ fallbacks: ['b/image'] });
      await generate();

      expect(llm.operationData).toHaveBeenCalledTimes(1);
      const opInput = llm.operationData.mock.calls[0][0] as {
        kind: string;
        contentKind: unknown;
        limitUsd: Prisma.Decimal;
        bookVersionId: string;
        createdById: string;
      };
      expect(opInput).toMatchObject({
        kind: 'draft',
        contentKind: null,
        bookVersionId: 'v-1',
        createdById: 'admin-1',
      });
      // 0.25 × (1 основная + 1 запасная) × 1.5
      expect(opInput.limitUsd.toFixed(2)).toBe('0.75');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual(DRAFT_TX_OPTIONS);
      expect(tx.llmOperation.create).toHaveBeenCalledTimes(1);
      expect(tasks.enqueue).toHaveBeenCalledTimes(1);
      expect(tasks.enqueue).toHaveBeenCalledWith(
        {
          kind: 'world_image',
          operationId: 'op-new',
          bookVersionId: 'v-1',
          payload: { key: 'oblomov' },
          pairKey: 'world_image:op-new',
        },
        tx,
      );
      expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
      expect(tx.bookWorldImage.update).toHaveBeenCalledWith({
        where: { id: 'img-1' },
        data: { operationId: 'op-new' },
      });
    });

    it.each([
      ['a minor character', { ...ENTITY, role: 'minor' }, 'WORLD_IMAGE_NOT_ALLOWED'],
      ['a pair', { ...ENTITY, type: 'pair', role: null }, 'WORLD_IMAGE_NOT_ALLOWED'],
      [
        'no appearance text',
        { ...ENTITY, blocks: { appearance: '  ' } },
        'WORLD_IMAGE_NO_APPEARANCE',
      ],
    ])('%s - 409 before any money is touched', async (_, entity, code) => {
      prisma.bookWorldEntity.findUnique.mockResolvedValue(entity);
      const error = await generate().catch((e: unknown) => e);
      expect(codeOf(error)).toBe(code);
      expect(llm.operationData).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('no entity - 404', async () => {
      prisma.bookWorldEntity.findUnique.mockResolvedValue(null);
      await expect(generate()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the spending ceiling is reached - 409 LLM_CEILING_REACHED, no operation', async () => {
      budget.ceilingReached.mockResolvedValue(true);
      expect(codeOf(await generate().catch((e: unknown) => e))).toBe('LLM_CEILING_REACHED');
      expect(llm.operationData).not.toHaveBeenCalled();
    });

    it('the LLM is disabled - its refusal goes through, no operation', async () => {
      const disabled = new Error('LLM_DISABLED');
      llm.assertEnabled.mockImplementation(() => {
        throw disabled;
      });
      await expect(generate()).rejects.toBe(disabled);
      expect(llm.operationData).not.toHaveBeenCalled();
    });

    it('a generation is running - 409 WORLD_IMAGE_IN_PROGRESS, nothing created', async () => {
      locked = { ...LOCKED, operationId: 'op-old', operationStatus: 'active' };
      expect(codeOf(await generate().catch((e: unknown) => e))).toBe('WORLD_IMAGE_IN_PROGRESS');
      expect(tx.llmOperation.create).not.toHaveBeenCalled();
      expect(tasks.enqueue).not.toHaveBeenCalled();
    });

    it('a paused image operation is cancelled and replaced by a new one (Q2)', async () => {
      locked = { ...LOCKED, operationId: 'op-old', operationStatus: 'paused' };
      await generate();
      expect(tx.llmOperation.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.llmOperation.updateMany).toHaveBeenCalledWith({
        where: { id: 'op-old', status: { in: ['active', 'paused'] } },
        data: { status: 'cancelled', pauseReason: null },
      });
      expect(tasks.enqueue).toHaveBeenCalledTimes(1);
    });

    it('a paused operation whose step is still running - 409, not cancelled (Q2)', async () => {
      locked = {
        ...LOCKED,
        operationId: 'op-old',
        operationStatus: 'paused',
        operationRunning: true,
      };
      expect(codeOf(await generate().catch((e: unknown) => e))).toBe('WORLD_IMAGE_IN_PROGRESS');
      expect(tx.llmOperation.updateMany).not.toHaveBeenCalled();
      expect(tx.llmOperation.create).not.toHaveBeenCalled();
    });

    it('a finished operation whose task is still running does not block the new one: the pair is per operation', async () => {
      locked = {
        ...LOCKED,
        operationId: 'op-old',
        operationStatus: 'done',
        operationRunning: true,
      };
      await generate();
      expect(tasks.enqueue).toHaveBeenCalledTimes(1);
      expect((tasks.enqueue.mock.calls[0][0] as { pairKey: string }).pairKey).toBe(
        'world_image:op-new',
      );
    });

    it('the task was not inserted - 409 and the row is not pointed at a taskless operation', async () => {
      tasks.enqueue.mockResolvedValue({ created: false, holder: {} });
      expect(codeOf(await generate().catch((e: unknown) => e))).toBe('WORLD_IMAGE_IN_PROGRESS');
      expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    const accept = (id = 'm-pending') => service.accept('v-1', 'oblomov', id);

    it('moves the pending image to the accepted cell', async () => {
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      await accept();
      expect(tx.bookWorldImage.update).toHaveBeenCalledTimes(1);
      const call = tx.bookWorldImage.update.mock.calls[0][0] as {
        where: unknown;
        data: { imageMediaId: string; imageReadAt: Date; pendingMediaId: null };
      };
      expect(call.where).toEqual({ id: 'img-1' });
      expect(call.data).toMatchObject({ imageMediaId: 'm-pending', pendingMediaId: null });
      expect(call.data.imageReadAt).toBeInstanceOf(Date);
    });

    it.each([
      ['nothing pending', { pendingMediaId: null, pendingDeleted: null }, 'WORLD_IMAGE_NONE'],
      [
        'the pending file was deleted',
        { pendingMediaId: 'm-pending', pendingDeleted: true },
        'WORLD_IMAGE_NONE',
      ],
      [
        'another pending image',
        { pendingMediaId: 'm-other', pendingDeleted: false },
        'WORLD_IMAGE_CHANGED',
      ],
    ])('%s - 409 %s', async (_, cell, code) => {
      locked = { ...LOCKED, ...cell };
      expect(codeOf(await accept().catch((e: unknown) => e))).toBe(code);
      expect(tx.bookWorldImage.update).not.toHaveBeenCalled();
    });

    it('the character lost the right to an image - 409 WORLD_IMAGE_NOT_ALLOWED (Q1)', async () => {
      prisma.bookWorldEntity.findUnique.mockResolvedValue({ ...ENTITY, role: 'minor' });
      locked = { ...LOCKED, pendingMediaId: 'm-pending', pendingDeleted: false };
      expect(codeOf(await accept().catch((e: unknown) => e))).toBe('WORLD_IMAGE_NOT_ALLOWED');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('state', () => {
    const FILE = { id: 'm-1', url: 'https://media/a.png', width: 1536, height: 1536 };

    it('accepted by the same rule as the site, pending without the deleted file, the failed reason from the task', async () => {
      prisma.bookWorldImage.findUnique.mockResolvedValue({
        imageReadAt: new Date('2026-11-23T10:00:00Z'),
        image: { ...FILE, isDeleted: false },
        pending: { ...FILE, id: 'm-2', isDeleted: true },
        operation: { id: 'op-1', status: 'failed', pauseReason: null, spentUsd: D('0.04') },
      });
      prisma.llmTask.findFirst.mockResolvedValue({ lastError: 'WORLD_IMAGE_NOT_IMAGE' });
      const state = await service.state('v-1', 'oblomov');
      expect(state).toEqual({
        key: 'oblomov',
        allowed: true,
        roleAllowed: true,
        accepted: { mediaId: 'm-1', url: FILE.url, width: 1536, height: 1536 },
        acceptedAt: new Date('2026-11-23T10:00:00Z'),
        pending: null,
        generation: {
          operationId: 'op-1',
          status: 'failed',
          pauseReason: null,
          failedReason: 'WORLD_IMAGE_NOT_IMAGE',
          spentUsd: '0.04000000',
        },
        estimateUsd: '0.25000000',
      });
    });

    it('a deleted accepted file is not shown as accepted', async () => {
      prisma.bookWorldImage.findUnique.mockResolvedValue({
        imageReadAt: new Date(),
        image: { ...FILE, isDeleted: true },
        pending: null,
        operation: null,
      });
      const state = await service.state('v-1', 'oblomov');
      expect(state).toMatchObject({ accepted: null, acceptedAt: null, generation: null });
    });

    it('roleAllowed is the role alone (F08-12a, tail of F08-11b): no appearance - allowed false, roleAllowed true', async () => {
      prisma.bookWorldEntity.findUnique.mockResolvedValue({ ...ENTITY, blocks: {} });
      prisma.bookWorldImage.findUnique.mockResolvedValue(null);
      expect(await service.state('v-1', 'oblomov')).toMatchObject({
        allowed: false,
        roleAllowed: true,
      });
      prisma.bookWorldEntity.findUnique.mockResolvedValue({ ...ENTITY, role: 'minor' });
      expect(await service.state('v-1', 'oblomov')).toMatchObject({
        allowed: false,
        roleAllowed: false,
      });
    });

    it('a paused generation carries its pause reason (F08-12a, tail of F08-11b)', async () => {
      prisma.bookWorldImage.findUnique.mockResolvedValue({
        imageReadAt: null,
        image: null,
        pending: null,
        operation: {
          id: 'op-2',
          status: 'paused',
          pauseReason: 'CEILING_REACHED',
          spentUsd: D('0'),
        },
      });
      prisma.llmTask.findFirst.mockResolvedValue(null);
      const state = await service.state('v-1', 'oblomov');
      expect(state.generation).toMatchObject({
        status: 'paused',
        pauseReason: 'CEILING_REACHED',
      });
    });
  });
});
