import { LlmStageDefinition } from '../../llm/llm-stages.registry';

export const FINAL_CHECK_STAGE = 'final_check';

/**
 * Умолчание итоговой проверки (`tech.md` §3: «как `check_semantic`»): модель другого семейства, чем
 * умолчание перевода и его запасная (GPT и Claude, Р2 `F05 | F05-R`), и запасная третьего семейства -
 * иначе перевод моделью `deepseek`, выбранной редактором, не стартовал бы (решение арбитра
 * `F05 | F05-6`, 6c /fix круг 2, В2). Правило семейств -
 * на каждом вызове против моделей кусков главы и на оценке, старте, «продолжить» (6c В5).
 */
export const FINAL_CHECK_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: FINAL_CHECK_STAGE,
    model: 'deepseek/deepseek-v4-pro',
    fallbacks: ['z-ai/glm-5.3'],
    temperature: 0,
    // Рассуждения модели входят в ответ: при 2000 вердикт обрезался (Р4 `F05 | F05-R`).
    maxTokens: 8_000,
    enabled: true,
  },
];

/** Переводимых блоков главы в начале и в конце, которые читает модель (`product.md` §4, выборочно). */
export const FINAL_CHECK_EDGE_BLOCKS = 3;

/** Замечаний модели в находке главы не больше, каждое не длиннее: текст чужой модели. */
export const FINAL_CHECK_ISSUES_MAX = 5;
export const FINAL_CHECK_ISSUE_MAX_CHARS = 300;

/** Знаков вокруг найденной формы в находке глоссария. */
export const FINAL_FRAGMENT_CHARS = 40;

/**
 * Коды находок итоговой проверки в `TranslationChapter.findings` (`F05-6`, шаг 5). `FINAL_CHECKED` -
 * оплаченный ответ без провала, не флаг; остальные - флаг главы, глава пишется (решения арбитра
 * `F05 | F05-6`: находки - в отчёт и флаги глав).
 */
export const FINAL_FINDING_CODES = {
  FINAL_CHECKED: 'FINAL_CHECKED',
  /** Исходная форма записи глоссария, которой глоссарий дал другую, осталась в переводе (6c В7). */
  GLOSSARY_SOURCE_FORM: 'GLOSSARY_SOURCE_FORM',
  /** Собранная глава без текста, а в исходнике текст есть. */
  CHAPTER_EMPTY: 'CHAPTER_EMPTY',
  /** Модель нашла ошибку в начале или конце главы. */
  FINAL_CHECK_FAIL: 'FINAL_CHECK_FAIL',
  FINAL_NOT_INDEPENDENT: 'FINAL_NOT_INDEPENDENT',
  FINAL_CHECK_UNAVAILABLE: 'FINAL_CHECK_UNAVAILABLE',
  FINAL_CHECK_INPUT_TOO_LONG: 'FINAL_CHECK_INPUT_TOO_LONG',
  FINAL_CHECK_INVALID_RESPONSE: 'FINAL_CHECK_INVALID_RESPONSE',
} as const;

export type FinalFindingCode = (typeof FINAL_FINDING_CODES)[keyof typeof FINAL_FINDING_CODES];

/**
 * Причина языка на паузе `NO_COMPLIANT_PROVIDER` итоговой проверки - своя, как у сверки смысла
 * и `metadata`: выход - `stageModels.final_check`.
 */
export const FINAL_CHECK_NO_COMPLIANT_PROVIDER = 'FINAL_CHECK_NO_COMPLIANT_PROVIDER';
