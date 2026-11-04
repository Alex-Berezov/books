import { LlmStageDefinition, LlmStageRegistry } from '../../llm/llm-stages.registry';
import { CHECK_CALL_TIMEOUT_MS, CHECK_REASONING_ANSWER_RESERVE } from '../check/check.constants';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';

/**
 * Этапы хода анализа «Write Analysis» (`F07-1a`; `features/F07-analysis-autofill/tech.md` §2):
 * шаг 1 - карточка и герои, шаг 2 - цитаты и приёмы, шаг 3 - толкования; проверяющая - своя,
 * другого семейства, чем фактически ответивший автор. Шаги 4-5 - `F07-2`. Строк `LlmStageSetting`
 * нет - действует умолчание кода, экран «LLM settings» показывает этапы из реестра. Калибровка
 * лимитов - `F07-5`.
 */
export const ANALYSIS_CAST_WRITE_STAGE = 'analysis_cast_write';
export const ANALYSIS_QUOTES_WRITE_STAGE = 'analysis_quotes_write';
export const ANALYSIS_MEANING_WRITE_STAGE = 'analysis_meaning_write';
export const ANALYSIS_REVIEW_STAGE = 'analysis_review';

/** Вид задачи исполнителя хода анализа (`ContentDraft` вида `analysis_write`). */
export const ANALYSIS_WRITE_TASK_KIND = 'analysis_write';

/** Шагов в ходе `F07-1`: после третьего ход `ready` (решение арбитра `F07 | F07-1`, В4). */
export const ANALYSIS_STEPS = 3;

/** Таймаут вызова шага 1: 24 000 токенов ответа (`tech.md` §2). */
const CAST_CALL_TIMEOUT_MS = 600_000;
/** Таймаут вызова шага 3: 32 000 токенов ответа (`tech.md` §2, `LEGACY-479`). */
const MEANING_CALL_TIMEOUT_MS = 840_000;

const AUTHOR = 'z-ai/glm-5.3';
const AUTHOR_FALLBACKS = ['qwen/qwen3.7-plus', GPT_TERRA_MODEL];

/**
 * GLM-5.3 рассуждает, рассуждения идут в выход: резерв ответа и обрыв по лимиту без повтора той же
 * модели, как у этапов `F06` (`LEGACY-478`, `LEGACY-480`). Лимиты и резервы - `tech.md` §2.
 */
export const ANALYSIS_WRITE_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: ANALYSIS_CAST_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 24_000,
    enabled: true,
    reasoningAnswerReserve: 8_000,
    callTimeoutMs: CAST_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: ANALYSIS_QUOTES_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 16_000,
    enabled: true,
    reasoningAnswerReserve: 6_000,
    callTimeoutMs: CHECK_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: ANALYSIS_MEANING_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 32_000,
    enabled: true,
    reasoningAnswerReserve: 12_000,
    callTimeoutMs: MEANING_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: ANALYSIS_REVIEW_STAGE,
    model: 'openai/gpt-6-luna',
    fallbacks: ['deepseek/deepseek-v4-pro'],
    temperature: 0,
    maxTokens: 16_000,
    enabled: true,
    reasoningAnswerReserve: CHECK_REASONING_ANSWER_RESERVE,
    callTimeoutMs: CHECK_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
];

/**
 * Регистрация этапов хода анализа: видны на «LLM settings» и закреплены за задачей хода - её аренда
 * от их таймаутов (шаг 3 - 840 с, аренда 1 680 с), аренда прочих задач не растёт (механизм `F06-1`,
 * решения арбитра `F06 | F06-1`, В3, В4).
 */
export function registerAnalysisWriteStages(stages: LlmStageRegistry): void {
  for (const definition of ANALYSIS_WRITE_STAGE_DEFINITIONS) stages.register(definition);
  stages.registerTaskStages(
    ANALYSIS_WRITE_TASK_KIND,
    ANALYSIS_WRITE_STAGE_DEFINITIONS.map((d) => d.stage),
  );
}
