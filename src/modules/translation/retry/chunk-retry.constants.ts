/**
 * Почему перезапись главы черновика после повтора или правки куска не прошла (Р9; решение арбитра
 * `F05 | F05-7v`) - `TranslationChapter.rewriteRefusal`. Сверх них - коды сборки
 * (`ASSEMBLY_FLAG_REASONS`) и `SOURCE_CHANGED`: глава из такого перевода не собирается.
 */
export const REWRITE_REFUSALS = {
  /** Главу черновика правили руками после записи (хэш не сошёлся) или она не от запуска. */
  CHAPTER_EDITED_MANUALLY: 'CHAPTER_EDITED_MANUALLY',
  /** Версия уже не черновик: опубликованную главу конвейер не трогает. */
  VERSION_NOT_DRAFT: 'VERSION_NOT_DRAFT',
  /** Черновик удалили. */
  DRAFT_DELETED: 'DRAFT_DELETED',
} as const;

/** 409 повтора и правки: запуск идёт / на паре идёт повтор - коды исполнителя, один источник. */
export { RETRY_IN_PROGRESS, RUN_ACTIVE } from '../../llm-worker/llm-task.types';

/** Правку не применили под замком (строку главы или куска сменили встречно) - повторить (409). */
export const CHUNK_EDIT_CONFLICT = 'CHUNK_EDIT_CONFLICT';

/** Попытка повтора закрыта отменой своей операции (`retry.reason`). */
export const RETRY_CANCELLED = 'RETRY_CANCELLED';

/** Попытку сняли под замком до подмены (правка руками, новый повтор) - кусок не подменён. */
export const RETRY_NOT_APPLIED = 'RETRY_NOT_APPLIED';

/** Язык закончен без черновика: главу писать некуда - отказ до трат (409). */
export const DRAFT_MISSING = 'DRAFT_MISSING';

/** Главу исходника правили после нарезки: кусок не тот (409, Р13 - запуск не пересобирает). */
export const CHUNK_SOURCE_CHANGED = 'CHUNK_SOURCE_CHANGED';

/** Блоки правки руками не прошли проверку номеров или белого списка разметки (400). */
export const CHUNK_BLOCKS_INVALID = 'CHUNK_BLOCKS_INVALID';
