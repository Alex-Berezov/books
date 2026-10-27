import { ContentDraftKind } from '@prisma/client';
import { LlmStageDefinition } from '../../llm/llm-stages.registry';
import { GPT_TERRA_MODEL } from '../translate/translate.constants';

/** Этапы заготовок (`tech.md` §2б): у Summary имя этапа совпадает с видом, у Analysis - нет. */
export const SUMMARY_SECTIONS_STAGE = 'summary_sections';
export const SUMMARY_FULL_STAGE = 'summary_full';
export const SUMMARY_BRIEF_STAGE = 'summary_brief';
export const ANALYSIS_DRAFT_STAGE = 'analysis_draft';

/** Виды заготовки Summary (`F05-10`). */
export const SUMMARY_DRAFT_KINDS = [
  'summary_sections',
  'summary_full',
  'summary_brief',
] as const satisfies readonly ContentDraftKind[];

/** Все виды, которые принимают ручки заготовок: Summary и Analysis (`F05-11`). */
export const CONTENT_DRAFT_KINDS = [
  ...SUMMARY_DRAFT_KINDS,
  'analysis',
] as const satisfies readonly ContentDraftKind[];

/** Этап вида заготовки. */
export const DRAFT_STAGE_BY_KIND: Record<ContentDraftKind, string> = {
  summary_sections: SUMMARY_SECTIONS_STAGE,
  summary_full: SUMMARY_FULL_STAGE,
  summary_brief: SUMMARY_BRIEF_STAGE,
  analysis: ANALYSIS_DRAFT_STAGE,
};

/** Вид задачи исполнителя: одна на заготовку, по разделу за шаг. */
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
 * Умолчания этапов (`tech.md` §3: Claude, длинный контекст), запасная - `GPT_TERRA_MODEL`,
 * как у досье.
 */
export const CONTENT_DRAFT_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: SUMMARY_SECTIONS_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.3,
    maxTokens: 4_000,
    enabled: true,
  },
  {
    stage: SUMMARY_FULL_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.3,
    maxTokens: 16_000,
    enabled: true,
  },
  {
    stage: SUMMARY_BRIEF_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [GPT_TERRA_MODEL],
    temperature: 0.3,
    maxTokens: 6_000,
    enabled: true,
  },
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
/** У версии нет сохранённого раздела с текстом - полному не из чего строиться (В4). */
export const SUMMARY_SECTIONS_MISSING = 'SUMMARY_SECTIONS_MISSING';
/** У версии нет сохранённого полного пересказа с текстом - очень краткому не из чего (В4). */
export const SUMMARY_FULL_MISSING = 'SUMMARY_FULL_MISSING';
/** Досье исходника устарело: заготовка предлагает перестроить его (`F05-2`). */
export const DOSSIER_STALE = 'DOSSIER_STALE';
/** Лимит ниже лимитов досье и глоссария, которые строятся первыми (В9). */
export const DRAFT_LIMIT_TOO_LOW = 'DRAFT_LIMIT_TOO_LOW';

/** Отметка «раздел добавлен» - только у готовой заготовки разделов (Р1). */
export const DRAFT_NOT_READY = 'DRAFT_NOT_READY';
/** Отметка «раздел добавлен» с номером, которого нет среди разделов заготовки. */
export const DRAFT_SECTION_UNKNOWN = 'DRAFT_SECTION_UNKNOWN';

/**
 * Почему цитата заготовки Analysis выкинута (решения арбитра `F05 | F05-11`, Р6, Р9, Р19):
 * `OVER_LIMIT` - проверенная новая цитата сверх предела импорта вместе с сохранёнными.
 */
export const DROPPED_QUOTE_REASONS = [
  'NOT_FOUND',
  'NO_CHAPTER',
  'CHAPTER_MISSING',
  'OVER_LIMIT',
] as const;
export type DroppedQuoteReason = (typeof DROPPED_QUOTE_REASONS)[number];

/** Окончательные отказы заготовки (`failedReason`). */
export const DRAFT_INVALID_RESPONSE = 'DRAFT_INVALID_RESPONSE';
/** Вход этапа не влезает в контекст модели или ответ длиннее предела поля. */
export const DRAFT_TOO_LONG = 'DRAFT_TOO_LONG';
/** В досье нет плана разделов. */
export const DRAFT_NO_PLAN = 'DRAFT_NO_PLAN';
/** Досье запуска переведённой версии удалено вместе с исходником. */
export const DRAFT_DOSSIER_MISSING = 'DRAFT_DOSSIER_MISSING';
/** Предпосылка пропала по ходу (разделы или полный удалены до шага, у версии нет текста глав). */
export const DRAFT_INPUT_MISSING = 'DRAFT_INPUT_MISSING';
/** Операцию отменили со страницы операций, а не кнопкой «discard». */
export const DRAFT_CANCELLED = 'DRAFT_CANCELLED';
