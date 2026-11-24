import { LlmTask } from '@prisma/client';
import { LlmStageRegistry } from '../../llm/llm-stages.registry';
import { LlmOperationKindRegistry } from '../../llm-worker/llm-operation-kind.registry';
import { LlmTaskHandlerRegistry } from '../../llm-worker/llm-task-handler.registry';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { TranslationModule } from '../translation.module';
import { WORLD_IMAGE_GENERATION_REMOVED, WORLD_IMAGE_TASK_KIND } from './world-image.constants';
import { WorldImageHandler } from './world-image.handler';

const TASK = {
  id: 't-1',
  kind: 'world_image',
  operationId: 'op-1',
  bookVersionId: 'v-1',
  payload: { key: 'oblomov' },
} as unknown as LlmTask;

const CTX = {
  callOptions: { beforeAttempt: jest.fn(), signal: new AbortController().signal, taskId: 't-1' },
} as unknown as LlmTaskContext;

describe('WorldImageHandler - drain of world_image tasks (F08-11d-1, Q7)', () => {
  let tasks: { failOperation: jest.Mock };
  let handler: WorldImageHandler;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    tasks = { failOperation: jest.fn().mockResolvedValue(true) };
    handler = new WorldImageHandler(tasks as unknown as LlmTaskService);
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network'));
  });

  afterEach(() => fetchSpy.mockRestore());

  it('a left-over task fails with its reason and closes its operation; no model, no fetch', async () => {
    await expect(handler.handler.run(TASK, CTX)).resolves.toEqual({
      kind: 'fail',
      reason: WORLD_IMAGE_GENERATION_REMOVED,
    });
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).toHaveBeenCalledWith('op-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the operation is already stopped: still a failure, nothing else', async () => {
    tasks.failOperation.mockResolvedValue(false);
    await expect(handler.handler.run(TASK, CTX)).resolves.toEqual({
      kind: 'fail',
      reason: WORLD_IMAGE_GENERATION_REMOVED,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a failure outside the step (attempts exhausted) closes the operation too', async () => {
    await handler.handler.onFailed?.(TASK, 'TOO_MANY_ATTEMPTS');
    expect(tasks.failOperation).toHaveBeenCalledTimes(1);
    expect(tasks.failOperation).toHaveBeenCalledWith('op-1');
  });
});

describe('TranslationModule.onModuleInit (F08-11d-1)', () => {
  it('registers no world_image stage, but keeps a handler for world_image tasks', () => {
    const stages = new LlmStageRegistry();
    const handlers = new LlmTaskHandlerRegistry();
    const drain = new WorldImageHandler({} as LlmTaskService);
    const stub = { handler: { run: jest.fn() }, dossierHandler: { run: jest.fn() } };
    const other = { ...stub, glossaryHandler: { run: jest.fn() } } as never;
    new TranslationModule(
      stages,
      handlers,
      new LlmOperationKindRegistry(),
      other,
      other,
      other,
      other,
      other,
      other,
      other,
      other,
      other,
      drain,
    ).onModuleInit();

    expect(stages.get('world_image')).toBeUndefined();
    expect(stages.list().map((s) => s.stage)).not.toContain('world_image');
    expect(handlers.get(WORLD_IMAGE_TASK_KIND)).toBe(drain.handler);
  });
});
