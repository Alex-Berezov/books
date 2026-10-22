/** Вид задачи сравнения: одна на операцию, по куску одной модели за шаг (решение арбитра `F05 | F05-3`, С8). */
export const COMPARE_TASK_KIND = 'compare';

/** Заводка сравнения: операция, строка, колонки и задача - короткими INSERT (`L-020`). */
export const COMPARE_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/** Ответ модели не по форме после двух повторов с замечанием. */
export const COMPARE_INVALID_RESPONSE = 'COMPARE_INVALID_RESPONSE';
/** Кусок с контекстом не влезает в контекст модели: вызов не делается. */
export const COMPARE_TOO_LONG = 'COMPARE_TOO_LONG';
/** Собранная глава длиннее предела `RICH_HTML_MAX_LENGTH.body`. */
export const COMPARE_CHAPTER_TOO_LONG = 'COMPARE_CHAPTER_TOO_LONG';
/** Текст главы поменялся после старта: куски уже не те, операция закрывается отказом. */
export const COMPARE_CHAPTER_CHANGED = 'COMPARE_CHAPTER_CHANGED';

/**
 * Отказ одной модели - в её колонку, сравнение идёт дальше: «одна упала - вторая видна»
 * (`product.md` §7 п.11). Бюджет и остановка уходят исполнителю: пауза всей операции.
 */
export const COMPARE_MODEL_ERRORS = new Set([
  'LLM_NO_COMPLIANT_PROVIDER',
  'LLM_PROVIDER_ERROR',
  'LLM_UNAVAILABLE',
  'LLM_NO_PRICE',
  'LLM_STAGE_DISABLED',
]);
