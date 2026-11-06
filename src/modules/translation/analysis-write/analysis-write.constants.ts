import { LlmStageDefinition, LlmStageRegistry } from '../../llm/llm-stages.registry';
import { CHECK_CALL_TIMEOUT_MS, CHECK_REASONING_ANSWER_RESERVE } from '../check/check.constants';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';

/**
 * Этапы хода анализа «Write Analysis» (`F07-1a`; `features/F07-analysis-autofill/tech.md` §2):
 * шаг 1 - карточка и герои, шаг 2 - цитаты и приёмы, шаг 3 - толкования, шаг 4 - блоки для читателя, шаг 5 - внешние блоки с проверкой источников; проверяющая - своя,
 * другого семейства, чем фактически ответивший автор. Строк `LlmStageSetting`
 * нет - действует умолчание кода, экран «LLM settings» показывает этапы из реестра. Калибровка
 * лимитов - `F07-5`.
 */
export const ANALYSIS_CAST_WRITE_STAGE = 'analysis_cast_write';
export const ANALYSIS_QUOTES_WRITE_STAGE = 'analysis_quotes_write';
export const ANALYSIS_MEANING_WRITE_STAGE = 'analysis_meaning_write';
export const ANALYSIS_READER_WRITE_STAGE = 'analysis_reader_write';
export const ANALYSIS_EXTERNAL_WRITE_STAGE = 'analysis_external_write';
export const ANALYSIS_REVIEW_STAGE = 'analysis_review';

/** Вид задачи исполнителя хода анализа (`ContentDraft` вида `analysis_write`). */
export const ANALYSIS_WRITE_TASK_KIND = 'analysis_write';

/**
 * Шагов в новом ходе (`F07-2a`): после пятого ход `ready`. Ходы `F07-1` шли тремя шагами (решение
 * арбитра `F07 | F07-1`, В4): число шагов хода лежит в его данных (`stepsTotal`, нет поля - 3).
 */
export const ANALYSIS_STEPS = 5;
/** Шагов в ходе без поля `stepsTotal` - ходы `F07-1`. */
export const LEGACY_ANALYSIS_STEPS = 3;
/** Шаг с блоками для читателя (`F07-2a`): по итогам шагов 1-3 и кратким содержаниям глав. */
export const READER_STEP = 4;
/** Внешний шаг с проверкой источников (`F07-2a`): текста книги не читает. */
export const EXTERNAL_STEP = 5;
/** Шаг, после которого считается ядро (`CORE_MISSING`): шаги 4-5 на ядро не влияют. */
export const CORE_STEP = 3;

/**
 * Шаги, блоки которых перегенерируются (`tech.md` §2:42): шаги 1-2 с `F07-1b`, шаг 3 и шаги 4-5 с
 * `F07-2b` (решение арбитра `F07 | F07-1b`). Разрешающий список, а не запрет прочих: новый шаг без
 * решения сюда не попадает. `sources` и связи тем отдельно не перегенерируются (`NOT_REGENERABLE`).
 */
export const REGENERABLE_STEPS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * Единицы записи, которые не перегенерируются сами (решение арбитра `F07 | F07-2b`, п.1): источники
 * переписываются вместе с блоком шага 5, который на них ссылается.
 */
export const NOT_REGENERABLE: readonly string[] = ['sources'];

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
    stage: ANALYSIS_READER_WRITE_STAGE,
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
    stage: ANALYSIS_EXTERNAL_WRITE_STAGE,
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

/**
 * Коды отказов ручек `content-drafts/:id/*` для хода анализа (`F07-1b`, решение арбитра
 * `F07 | F07-1`, В6): `ANALYSIS_WRITE_NOT_READY` - ход строится, упал или отброшен;
 * `ANALYSIS_ITEM_UNKNOWN` (400) - у хода нет блока с таким номером; `ANALYSIS_ITEM_NOT_PROPOSED` -
 * блок не предложение; `ANALYSIS_BLOCK_CHANGED` - блок изменили после предложения (в теле `current`);
 * `ANALYSIS_WRITE_REFUSED` - анализ отказал в записи (ссылки не сошлись на слитом объекте);
 * `ANALYSIS_REGEN_IN_PROGRESS` - этот блок уже перегенерируется; `ANALYSIS_ITEM_NOT_REGENERABLE` -
 * связи тем и источники сами не перегенерируются (`NOT_REGENERABLE`).
 */
export const ANALYSIS_WRITE_NOT_READY = 'ANALYSIS_WRITE_NOT_READY';
export const ANALYSIS_ITEM_UNKNOWN = 'ANALYSIS_ITEM_UNKNOWN';
export const ANALYSIS_ITEM_NOT_PROPOSED = 'ANALYSIS_ITEM_NOT_PROPOSED';
export const ANALYSIS_BLOCK_CHANGED = 'ANALYSIS_BLOCK_CHANGED';
export const ANALYSIS_WRITE_REFUSED = 'ANALYSIS_WRITE_REFUSED';
export const ANALYSIS_REGEN_IN_PROGRESS = 'ANALYSIS_REGEN_IN_PROGRESS';
export const ANALYSIS_ITEM_NOT_REGENERABLE = 'ANALYSIS_ITEM_NOT_REGENERABLE';

/**
 * Почему «Accept all» оставил пункт предложением (решение арбитра `F07 | F07-3`, п.7): 409 самого
 * пункта - запись отказала (повисшая ссылка, список источников полон), блок изменил редактор,
 * блок перегенерируется. Пункт с идущей перегенерацией до попытки не доходит и сюда не попадает.
 */
export const ACCEPT_ALL_SKIP_CODES = [
  ANALYSIS_WRITE_REFUSED,
  ANALYSIS_BLOCK_CHANGED,
  ANALYSIS_REGEN_IN_PROGRESS,
] as const;
export type AcceptAllSkipCode = (typeof ACCEPT_ALL_SKIP_CODES)[number];
