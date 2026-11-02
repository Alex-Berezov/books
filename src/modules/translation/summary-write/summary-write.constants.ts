import { LlmStageDefinition, LlmStageRegistry } from '../../llm/llm-stages.registry';
import { CHECK_CALL_TIMEOUT_MS, CHECK_REASONING_ANSWER_RESERVE } from '../check/check.constants';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';

/**
 * Этапы чистовика пересказа (`F06`; `features/F06-summary-autofill/tech.md` §3). Автор по умолчанию -
 * GLM-5.3 (D3), запасные - модели других семейств; проверяющая - другого семейства, чем фактически
 * ответивший автор (U4, `runQualityLoop`). Строк `LlmStageSetting` для них нет - действует умолчание
 * кода, экран «LLM settings» показывает этапы из реестра. Калибровка лимитов - `F06-6`.
 */
export const SUMMARY_SECTION_WRITE_STAGE = 'summary_section_write';
export const SUMMARY_FULL_WRITE_STAGE = 'summary_full_write';
export const SUMMARY_BRIEF_WRITE_STAGE = 'summary_brief_write';
export const SUMMARY_REVIEW_STAGE = 'summary_review';

/** Вид задачи исполнителя хода раздела (`ContentDraft` вида `summary_write`); обработчик - `F06-2`. */
export const SUMMARY_WRITE_TASK_KIND = 'summary_write';

/** Таймаут вызова полного пересказа: 24 000 токенов ответа (`tech.md` §3). */
const SUMMARY_FULL_CALL_TIMEOUT_MS = 600_000;

const AUTHOR = 'z-ai/glm-5.3';
const AUTHOR_FALLBACKS = ['qwen/qwen3.7-plus', GPT_TERRA_MODEL];

/**
 * GLM-5.3 рассуждает, рассуждения идут в выход: каждому этапу - резерв ответа и обрыв по лимиту
 * без повтора той же модели (`LEGACY-478`, `LEGACY-480`; поля у пишущих этапов - решение арбитра
 * `F06 | F06-1`, В1). Таймаут 420 с - как у проверяющих (`CHECK_CALL_TIMEOUT_MS`), 600 с - у полного.
 */
export const SUMMARY_WRITE_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: SUMMARY_SECTION_WRITE_STAGE,
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
    stage: SUMMARY_FULL_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 24_000,
    enabled: true,
    reasoningAnswerReserve: 10_000,
    callTimeoutMs: SUMMARY_FULL_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: SUMMARY_BRIEF_WRITE_STAGE,
    model: AUTHOR,
    fallbacks: AUTHOR_FALLBACKS,
    temperature: 0.4,
    maxTokens: 16_000,
    enabled: true,
    reasoningAnswerReserve: 5_000,
    callTimeoutMs: CHECK_CALL_TIMEOUT_MS,
    truncationEndsModel: true,
  },
  {
    stage: SUMMARY_REVIEW_STAGE,
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
 * Регистрация этапов чистовика: видны на «LLM settings» и закреплены за задачей хода раздела - её
 * аренда от их таймаутов, аренда прочих задач не растёт (решения арбитра `F06 | F06-1`, В3, В4).
 */
export function registerSummaryWriteStages(stages: LlmStageRegistry): void {
  for (const definition of SUMMARY_WRITE_STAGE_DEFINITIONS) stages.register(definition);
  stages.registerTaskStages(
    SUMMARY_WRITE_TASK_KIND,
    SUMMARY_WRITE_STAGE_DEFINITIONS.map((d) => d.stage),
  );
}
