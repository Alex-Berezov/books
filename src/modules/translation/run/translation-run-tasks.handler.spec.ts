import { LlmOperation } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { ChunkRunStepsService } from './chunk-run-steps.service';
import { ContextRunStepsService } from './context-run-steps.service';
import { MetadataDraftRunStepsService } from './metadata-draft-run-steps.service';
import { RunStepSupportService } from './run-step-support.service';
import { TranslationRunTasksHandler } from './translation-run-tasks.handler';
import { UNRESUMABLE_REASONS } from './translation-run.constants';

/**
 * Тупиковые причины паузы - один источник (`UNRESUMABLE_REASONS`): ими же обработчик отвечает
 * исполнителю, и с ними же «продолжить» не ставит задач, не читая запуск.
 */

function setup() {
  const db = { translationRun: { findUnique: jest.fn().mockResolvedValue(null) } };
  const handler = new TranslationRunTasksHandler(
    db as unknown as PrismaService,
    {} as LlmTaskService,
    {} as RunStepSupportService,
    {} as ContextRunStepsService,
    {} as ChunkRunStepsService,
    {} as MetadataDraftRunStepsService,
  );
  return { handler, db };
}

describe('TranslationRunTasksHandler', () => {
  it('отвечает исполнителю тупиковыми причинами из константы', () => {
    expect(setup().handler.unresumableReasons).toBe(UNRESUMABLE_REASONS);
  });

  it.each(UNRESUMABLE_REASONS)(
    '«продолжить» на паузе %s - задач нет, запуск не читается',
    async (reason) => {
      const { handler, db } = setup();
      const op = { id: 'op1', pauseReason: reason } as LlmOperation;
      await expect(handler.resumeTasks(op)).resolves.toEqual([]);
      expect(db.translationRun.findUnique).not.toHaveBeenCalled();
    },
  );

  it('«продолжить» на другой паузе читает запуск', async () => {
    const { handler, db } = setup();
    const op = { id: 'op1', pauseReason: 'LIMIT_REACHED' } as LlmOperation;
    await expect(handler.resumeTasks(op)).resolves.toEqual([]);
    expect(db.translationRun.findUnique).toHaveBeenCalledTimes(1);
  });
});
