import { TranslationChunkStatus } from '@prisma/client';

/** Вид задачи запуска: шаг языка, одна задача на пару «операция, язык» (Р1). */
export const TRANSLATION_RUN_TASK_KIND = 'translation_run';

/**
 * Кусков главы, которые шаг читает за раз. Глава не длиннее `RICH_HTML_MAX_LENGTH.body`, а кусок
 * не короче 1500 слов, - реальная глава даёт единицы кусков; предел держит выборку конечной.
 */
export const RUN_CHAPTER_CHUNKS_MAX = 500;

/** Короткие записи шага и переходы запуска (`L-020`). */
export const RUN_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/** Кусок закрыт: переведён и находки дописаны, или с флагом. Одно правило на шаг и ход запуска. */
export const CHUNK_CLOSED_STATUSES: readonly TranslationChunkStatus[] = ['done', 'flagged'];

/** Кусок с контекстом не влезает в контекст модели: вызова нет, кусок с флагом. */
export const CHUNK_TOO_LONG = 'CHUNK_TOO_LONG';
/** Ответ модели не по форме после двух повторов с замечанием: кусок с флагом (`tech.md` §5). */
export const CHUNK_INVALID_RESPONSE = 'CHUNK_INVALID_RESPONSE';
/** Кусок в статусе, который шаг перевода не ведёт: отказ шага, а не повторный платный вызов. */
export const CHUNK_STATUS_UNEXPECTED = 'CHUNK_STATUS_UNEXPECTED';
