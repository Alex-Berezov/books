import { TranslationChunkStatus } from '@prisma/client';

/** Вид задачи запуска: шаг языка, одна задача на пару «операция, язык» (Р1). */
export const TRANSLATION_RUN_TASK_KIND = 'translation_run';

/**
 * Кусков главы, которые шаг читает за раз. Глава не длиннее `RICH_HTML_MAX_LENGTH.body`, а кусок
 * не короче 1500 слов, - реальная глава даёт единицы кусков; предел держит выборку конечной.
 */
export const RUN_CHAPTER_CHUNKS_MAX = 500;

/** Языков у запуска - не больше языков книги (`@@unique([runId, language])`): предел выборок по языкам. */
export const RUN_LANGUAGES_MAX = 5;

/** Операций досье и глоссария в ходе запуска (`F05-7`): досье, до пяти глоссариев и пере-заведённые. */
export const RUN_OPERATIONS_MAX = 50;

/**
 * Пауза запуска до трат: лимиту запуска не хватило на операцию досье или глоссария (Р20) - у языка
 * свой код и лимит запуска, с которым она поместится (`reasonUsd`), а не «лимит достигнут»
 * (решение арбитра `F05 | F05-7`, /fix В2).
 */
export const DOSSIER_LIMIT_TOO_LOW = 'DOSSIER_LIMIT_TOO_LOW';

/** Незавершённые статусы языка запуска: шаги идут, язык держит своё место (`F05-4a`). */
export const RUN_LANGUAGE_UNFINISHED = ['pending', 'running'] as const;

/** Короткие записи шага и переходы запуска (`L-020`). */
export const RUN_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/**
 * Транзакция находок итоговой проверки кодом - запись главы (и счётчика) на каждую главу языка,
 * до `DOSSIER_MAX_CHAPTERS`: свой срок, как у соседей с длинным обходом (`AUTHOR_DELETE_TX_OPTIONS`,
 * `author.service.ts`), а не пара записей `RUN_TX_OPTIONS` (L-020).
 */
export const FINAL_CODE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/** Кусок закрыт: переведён и находки дописаны, или с флагом. Одно правило на шаг и ход запуска. */
export const CHUNK_CLOSED_STATUSES: readonly TranslationChunkStatus[] = ['done', 'flagged'];

/** Кусок с контекстом не влезает в контекст модели: вызова нет, кусок с флагом. */
export const CHUNK_TOO_LONG = 'CHUNK_TOO_LONG';
/** Ответ модели не по форме после двух повторов с замечанием: кусок с флагом (`tech.md` §5). */
export const CHUNK_INVALID_RESPONSE = 'CHUNK_INVALID_RESPONSE';
/** Кусок в статусе, который шаг перевода не ведёт: отказ шага, а не повторный платный вызов. */
export const CHUNK_STATUS_UNEXPECTED = 'CHUNK_STATUS_UNEXPECTED';

/** Предел текста отказа сервиса в `TranslationRunLanguage.reasonText` (`F05-6`, 6b). */
export const CREATE_REJECTED_TEXT_MAX = 300;
