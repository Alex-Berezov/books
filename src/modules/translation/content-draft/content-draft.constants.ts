import { ContentDraftKind } from '@prisma/client';

/**
 * Снятые виды заготовок: пошаговые Summary `F05-10` (сняты в `F06-3`, заменены ходом
 * `summary_write`) и Analysis «Draft from dossier» `F05-11` (снят в `F07-3a`, заменён ходом
 * `analysis_write`). Вид в enum и строки таблицы остаются, ручек у них нет, строящиеся
 * отбрасываются дренажем при старте и обработчиком задачи (решения арбитра `F06 | F06-3`, А1, А2;
 * `F07 | F07-3`). Один список на все снятые виды - второй механики снятия не заводить.
 */
export const RETIRED_DRAFT_KINDS = [
  'summary_sections',
  'summary_full',
  'summary_brief',
  'analysis',
] as const satisfies readonly ContentDraftKind[];

/** Вид задачи исполнителя: одна на заготовку. */
export const CONTENT_DRAFT_TASK_KIND = 'content_draft';

/** Лимит операции по умолчанию - оценка этапа × 1,5, как у досье и сравнения. */
export const DRAFT_LIMIT_FACTOR = '1.5';

/** Заводка заготовки: операция, строка и задача - короткими INSERT (`L-020`). */
export const DRAFT_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/** Строящаяся заготовка того же вида уже есть (решение арбитра `F05 | F05-10`, В7). */
export const DRAFT_IN_PROGRESS = 'DRAFT_IN_PROGRESS';
/** Досье исходника устарело: заготовка предлагает перестроить его (`F05-2`). */
export const DOSSIER_STALE = 'DOSSIER_STALE';
/** Лимит ниже лимитов досье и глоссария, которые строятся первыми (В9). */
export const DRAFT_LIMIT_TOO_LOW = 'DRAFT_LIMIT_TOO_LOW';

/** Окончательные отказы заготовки (`failedReason`). */
export const DRAFT_INVALID_RESPONSE = 'DRAFT_INVALID_RESPONSE';
/** Вход этапа не влезает в контекст модели или ответ длиннее предела поля. */
export const DRAFT_TOO_LONG = 'DRAFT_TOO_LONG';
/** Элемент `ContentDraft.data` хода `F06` не той формы: на его месте заглушка «не удалось». */
export const DRAFT_DATA_INVALID = 'DRAFT_DATA_INVALID';
/** Досье запуска переведённой версии удалено вместе с исходником. */
export const DRAFT_DOSSIER_MISSING = 'DRAFT_DOSSIER_MISSING';
/** Предпосылка пропала по ходу: у версии нет текста глав или досье удалено до шага. */
export const DRAFT_INPUT_MISSING = 'DRAFT_INPUT_MISSING';
/** Операцию отменили со страницы операций, а не кнопкой «discard». */
export const DRAFT_CANCELLED = 'DRAFT_CANCELLED';
