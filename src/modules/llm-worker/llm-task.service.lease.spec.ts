import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmConfig } from '../llm/llm.config';
import { LlmStageDefinition, LlmStageRegistry } from '../llm/llm-stages.registry';
import { LlmTaskService } from './llm-task.service';
import { LlmWorkerConfig } from './llm-worker.config';

// Аренда задачи от самого длинного таймаута этапа (`LEGACY-479`, решение арбитра `F05 | F05-13c`):
// задача не знает, какой этап позовёт, а попытка проверяющего длиннее общего таймаута.
describe('LlmTaskService lease', () => {
  const stage = (name: string, callTimeoutMs?: number): LlmStageDefinition => ({
    stage: name,
    model: 'a/m',
    fallbacks: [],
    temperature: 0,
    maxTokens: 10,
    enabled: true,
    ...(callTimeoutMs ? { callTimeoutMs } : {}),
  });
  const leaseOf = (stages: LlmStageRegistry) => {
    const config = { get: (k: string) => (k === 'LLM_CALL_TIMEOUT_MS' ? '180000' : undefined) };
    return new LlmTaskService(
      {} as PrismaService,
      new LlmConfig(config as unknown as ConfigService),
      new LlmWorkerConfig(config as unknown as ConfigService),
      stages,
    ).leaseMs();
  };

  it('is two common timeouts while no stage has a longer one', () => {
    const stages = new LlmStageRegistry();
    stages.register(stage('plain'));
    stages.register(stage('short', 60_000));
    expect(leaseOf(stages)).toBe(360_000);
  });

  it('is two of the longest stage timeout when one exceeds the common', () => {
    const stages = new LlmStageRegistry();
    stages.register(stage('plain'));
    stages.register(stage('checker', 420_000));
    expect(leaseOf(stages)).toBe(840_000);
  });
});
