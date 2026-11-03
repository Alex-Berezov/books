import { ContentDraftKind } from '@prisma/client';
import { LlmStageDefinition } from '../../llm/llm-stages.registry';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';
import { QUOTE_CHECK_REASONS } from '../draft-quality/quote-check';

/** Этап заготовки Analysis (`F05-11`). */
export const ANALYSIS_DRAFT_STAGE = 'analysis_draft';

/**
 * Пошаговые заготовки Summary `F05-10`, снятые в `F06-3` (`tech.md` §3): вид в enum и строки
 * таблицы остаются, ручки их не принимают, строящиеся отбрасываются дренажем (решения арбитра
 * `F06 | F06-3`, А1, А2).
 */
export const RETIRED_SUMMARY_DRAFT_KINDS = [
  'summary_sections',
  'summary_full',
  'summary_brief',
] as const satisfies readonly ContentDraftKind[];

/** Виды, которые принимают ручки заготовок: только Analysis (`F05-11`). */
export const CONTENT_DRAFT_KINDS = ['analysis'] as const satisfies readonly ContentDraftKind[];

/** Вид заготовки `F05-11`; ход пересказа `summary_write` (`F06`) сюда не входит. */
export type DraftKind = (typeof CONTENT_DRAFT_KINDS)[number];

/** Вид задачи исполнителя: одна на заготовку. */
export const CONTENT_DRAFT_TASK_KIND = 'content_draft';

/** Лимит операции по умолчанию - оценка этапа × 1,5, как у досье и сравнения. */
export const DRAFT_LIMIT_FACTOR = '1.5';

/**
 * Повторов с замечанием у вызова анализа после проверок сохранения (Р2): одна константа на шаг
 * и на лимит по умолчанию, чтобы расчёт и вызов не разошлись (Р28).
 */
export const ANALYSIS_DRAFT_REMARKS = 1;

/** Заводка заготовки: операция, строка и задача - короткими INSERT (`L-020`). */
export const DRAFT_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/**
 * Умолчание этапа (`tech.md` §3 `F05`: Claude, длинный контекст), запасная - `GPT_TERRA_MODEL`,
 * как у досье. Этапы `summary_sections`/`summary_full`/`summary_brief` сняты в `F06-3`: их строки
 * `LlmStageSetting` экран не показывает (фильтр по реестру).
 */
export const CONTENT_DRAFT_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: ANALYSIS_DRAFT_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.2,
    // Ответ - до 20 героев, 12 цитат и 10 приёмов с примерами.
    maxTokens: 12_000,
    enabled: true,
  },
];

/** Строящаяся заготовка того же вида уже есть (решение арбитра `F05 | F05-10`, В7). */
export const DRAFT_IN_PROGRESS = 'DRAFT_IN_PROGRESS';
/** Досье исходника устарело: заготовка предлагает перестроить его (`F05-2`). */
export const DOSSIER_STALE = 'DOSSIER_STALE';
/** Лимит ниже лимитов досье и глоссария, которые строятся первыми (В9). */
export const DRAFT_LIMIT_TOO_LOW = 'DRAFT_LIMIT_TOO_LOW';

/**
 * Почему цитата заготовки Analysis выкинута (решения арбитра `F05 | F05-11`, Р6, Р9, Р19):
 * `OVER_LIMIT` - проверенная новая цитата сверх предела импорта вместе с сохранёнными.
 */
export const DROPPED_QUOTE_REASONS = [...QUOTE_CHECK_REASONS, 'OVER_LIMIT'] as const;
export type DroppedQuoteReason = (typeof DROPPED_QUOTE_REASONS)[number];

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
