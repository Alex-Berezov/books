import { ConfigService } from '@nestjs/config';
import { LlmTask } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmConfig } from '../llm/llm.config';
import { LlmStageRegistry } from '../llm/llm-stages.registry';
import { LlmTaskService } from './llm-task.service';
import { LlmWorkerConfig } from './llm-worker.config';

/**
 * Итог шага `wait` (решение арбитра `F06 | F06-5`, уточнение механизма повтора автозапуска):
 * `runAfter` задан - пауза его, нет - `waitMs` воркера, как до правки; причина - в `lastError`.
 */
describe('LlmTaskService.finish: wait', () => {
  const WAIT_MS = 10_000;

  function setup() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'active' }]),
      llmTask: { updateMany },
    };
    const db = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const config = {
      get: (k: string) => (k === 'TRANSLATION_WORKER_WAIT_MS' ? String(WAIT_MS) : undefined),
    };
    const service = new LlmTaskService(
      db as unknown as PrismaService,
      new LlmConfig(config as unknown as ConfigService),
      new LlmWorkerConfig(config as unknown as ConfigService),
      new LlmStageRegistry(),
    );
    return { service, updateMany };
  }

  const task = { id: 't1', operationId: 'op1' } as LlmTask;
  type Written = [{ data: { status: string; runAfter: Date; lastError: string | null } }];

  it('wait без runAfter - пауза waitMs воркера, причина в lastError', async () => {
    const { service, updateMany } = setup();
    const before = Date.now();
    await service.finish(task, 'owner', { kind: 'wait', reason: 'DOSSIER_BUILDING' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const { data } = (updateMany.mock.calls[0] as Written)[0];
    expect(data.lastError).toBe('DOSSIER_BUILDING');
    expect(data.runAfter.getTime()).toBeGreaterThanOrEqual(before + WAIT_MS);
    expect(data.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + WAIT_MS);
  });

  it('wait с runAfter - своя пауза, причина в lastError', async () => {
    const { service, updateMany } = setup();
    const runAfter = new Date(Date.now() + 30_000);
    await service.finish(task, 'owner', {
      kind: 'wait',
      reason: 'LLM_MODELS_UNAVAILABLE',
      runAfter,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const { data } = (updateMany.mock.calls[0] as Written)[0];
    expect(data).toMatchObject({ status: 'pending', lastError: 'LLM_MODELS_UNAVAILABLE' });
    expect(data.runAfter).toBe(runAfter);
  });
});
