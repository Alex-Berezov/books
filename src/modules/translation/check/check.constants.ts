import { LlmStageDefinition } from '../../llm/llm-stages.registry';

export const CHECK_SEMANTIC_STAGE = 'check_semantic';
export const CHECK_JEV_STAGE = 'check_language_jev';

/**
 * Умолчания этапов проверки (`tech.md` §3). `check_mechanical` - только код, модели у него нет,
 * поэтому в реестр LLM не входит. `check_semantic` - модели другого семейства, чем умолчание
 * перевода (Claude); правило семейств сверяет каждый вызов с моделью, фактически переведшей
 * кусок. `check_language_jev` выключен до замера в `F05-R` (D7): строка этапа, сохранённая
 * на экране, закрепляет `enabled` (решение арбитра `F05 | F05-1s`); цена у модели динамическая -
 * резерв по потолку (Р24).
 */
export const CHECK_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: CHECK_SEMANTIC_STAGE,
    model: 'deepseek/deepseek-v4-pro',
    fallbacks: ['z-ai/glm-5.3'],
    temperature: 0,
    maxTokens: 2_000,
    enabled: true,
  },
  {
    stage: CHECK_JEV_STAGE,
    model: 'typesafe/jev-router',
    fallbacks: [],
    temperature: 0,
    maxTokens: 50,
    enabled: false,
    maxPricePerMTok: '5',
  },
];

/**
 * Неудач проверки до флага (`product.md` §4, «после двух неудач - флаг»; решение арбитра
 * `F05 | F05-5`): перевод, проверка, при провале один перевод заново с замечаниями. Повторы
 * ответа не по форме (`TRANSLATE_REMARKS`) сюда не входят.
 */
export const CHECK_FAILURES_MAX = 2;

/** Повторов с замечанием у ответа проверяющего не по форме (как у досье - один). */
export const CHECK_REMARKS = 1;

/** Предложений исходника на сверку смысла: от и до, число - от сида куска. */
export const SEMANTIC_SAMPLES_MIN = 3;
export const SEMANTIC_SAMPLES_MAX = 5;

/** Знаков перевода в вызове Jev: ему нужен язык, а не текст целиком. */
export const JEV_TEXT_MAX_CHARS = 4_000;

/** Замечаний на повтор перевода не больше, каждое не длиннее: текст чужой модели идёт в промпт. */
export const REVIEWER_REMARKS_MAX = 10;
export const REVIEWER_REMARK_MAX_CHARS = 500;

/**
 * Коды причин флага куска от проверок - одна таблица (`flagReason`, отчёт `F05-6`, экран
 * `F05-7`). Причины шага перевода - `run/translation-run.constants.ts` (`CHUNK_*`).
 */
export const CHECK_FLAG_REASONS = {
  /** Механика кодом (`tech.md` §6, 5а). */
  LANGUAGE_MISMATCH: 'LANGUAGE_MISMATCH',
  FOREIGN_SHARE: 'FOREIGN_SHARE',
  /** Блок от `FOREIGN_WINDOW_WORDS` слов уверенно не целевым языком (решение арбитра `F05 | F05-5`). */
  FOREIGN_BLOCK: 'FOREIGN_BLOCK',
  LENGTH_OUT_OF_RANGE: 'LENGTH_OUT_OF_RANGE',
  BLOCKS_MISMATCH: 'BLOCKS_MISMATCH',
  BLOCK_EMPTY: 'BLOCK_EMPTY',
  SERVICE_PHRASE: 'SERVICE_PHRASE',
  TRUNCATED: 'TRUNCATED',
  /** Jev определил другой язык - провал механики (карточка, шаг 5). */
  JEV_LANGUAGE_MISMATCH: 'JEV_LANGUAGE_MISMATCH',
  /** Провал сверки смысла: `fail`, неточный образец или потерянное имя. */
  SEMANTIC_FAIL: 'SEMANTIC_FAIL',
  /** Проверить смысл некому: все модели этапа - того же семейства, что переводчик (`tech.md` §3). */
  NOT_INDEPENDENT: 'NOT_INDEPENDENT',
  /** Исходник с переводом не влезает в контекст моделей проверки - как `CHUNK_TOO_LONG` у перевода. */
  CHECK_INPUT_TOO_LONG: 'CHECK_INPUT_TOO_LONG',
  /** Этап сверки смысла выключили или его модель потеряла цену посреди запуска. */
  CHECK_STAGE_UNAVAILABLE: 'CHECK_STAGE_UNAVAILABLE',
  /** Ответ проверяющего не по форме после повтора с замечанием - как у перевода (`tech.md` §5). */
  CHUNK_CHECK_INVALID_RESPONSE: 'CHUNK_CHECK_INVALID_RESPONSE',
} as const;

export type CheckFlagReason = (typeof CHECK_FLAG_REASONS)[keyof typeof CHECK_FLAG_REASONS];

/**
 * Причина языка на паузе `NO_COMPLIANT_PROVIDER` сверки смысла - отдельная от перевода
 * (`LLM_NO_COMPLIANT_PROVIDER`): выход - `stageModels.check_semantic`, а не `translate`.
 */
export const CHECK_NO_COMPLIANT_PROVIDER = 'CHECK_NO_COMPLIANT_PROVIDER';
