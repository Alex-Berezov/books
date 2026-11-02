import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmConfig } from '../llm/llm.config';
import { LlmStageDefinition, LlmStageRegistry } from '../llm/llm-stages.registry';
import { LlmTaskService } from './llm-task.service';
import {
  registerSummaryWriteStages,
  SUMMARY_WRITE_TASK_KIND,
} from '../translation/summary-write/summary-write.constants';
import { CHECK_STAGE_DEFINITIONS } from '../translation/check/check.constants';
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
  const leaseOf = (stages: LlmStageRegistry, kind = 'translation_run') => {
    const config = { get: (k: string) => (k === 'LLM_CALL_TIMEOUT_MS' ? '180000' : undefined) };
    return new LlmTaskService(
      {} as PrismaService,
      new LlmConfig(config as unknown as ConfigService),
      new LlmWorkerConfig(config as unknown as ConfigService),
      stages,
    ).leaseMs(kind);
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

  // Аренда по виду задачи (решение арбитра `F06 | F06-1`, В3): этапы, закреплённые за видом,
  // растят аренду только своего вида.
  it('a kind with its own stages leases from them; other kinds do not grow from those stages', () => {
    const stages = new LlmStageRegistry();
    stages.register(stage('checker', 420_000));
    stages.register(stage('summary_full_write', 600_000));
    stages.register(stage('summary_section_write', 420_000));
    stages.registerTaskStages('summary_write', ['summary_full_write', 'summary_section_write']);
    expect(leaseOf(stages, 'translation_run')).toBe(840_000);
    expect(leaseOf(stages, 'summary_write')).toBe(1_200_000);
  });

  it('a kind nobody registered leases from the stages no kind owns, at least two common timeouts', () => {
    const stages = new LlmStageRegistry();
    stages.register(stage('plain'));
    stages.register(stage('summary_full_write', 600_000));
    stages.registerTaskStages('summary_write', ['summary_full_write']);
    expect(leaseOf(stages, 'e2e_unknown_kind')).toBe(360_000);
    expect(stages.longestCallTimeoutMs(180_000)).toBe(600_000);
  });

  it('stages of a kind are registered once', () => {
    const stages = new LlmStageRegistry();
    stages.registerTaskStages('summary_write', []);
    expect(() => stages.registerTaskStages('summary_write', [])).toThrow(/already registered/);
  });

  it('a stage not in the registry or owned by another kind is refused, not silently ignored', () => {
    const stages = new LlmStageRegistry();
    stages.register(stage('summary_full_write', 600_000));
    expect(() => stages.registerTaskStages('summary_write', ['summary_ful_write'])).toThrow(
      /not registered/,
    );
    stages.registerTaskStages('summary_write', ['summary_full_write']);
    expect(() => stages.registerTaskStages('analysis_write', ['summary_full_write'])).toThrow(
      /already owned by task kind "summary_write"/,
    );
  });

  it('the real F06 registration: the summary task leases 1200 s, the translation tasks stay at 840 s', () => {
    const stages = new LlmStageRegistry();
    for (const definition of CHECK_STAGE_DEFINITIONS) stages.register(definition);
    registerSummaryWriteStages(stages);
    expect(leaseOf(stages, SUMMARY_WRITE_TASK_KIND)).toBe(1_200_000);
    expect(leaseOf(stages, 'translation_run')).toBe(840_000);
  });
});
