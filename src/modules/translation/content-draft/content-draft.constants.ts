import { ContentDraftKind } from '@prisma/client';
import { LlmStageDefinition } from '../../llm/llm-stages.registry';

/** Этапы заготовки Summary (`tech.md` §2б): имя этапа совпадает с видом заготовки. */
export const SUMMARY_SECTIONS_STAGE = 'summary_sections';
export const SUMMARY_FULL_STAGE = 'summary_full';
export const SUMMARY_BRIEF_STAGE = 'summary_brief';

/** Виды, которые принимают ручки `F05-10`; `analysis` - этап `F05-11`. */
export const SUMMARY_DRAFT_KINDS = [
  'summary_sections',
  'summary_full',
  'summary_brief',
] as const satisfies readonly ContentDraftKind[];
export type SummaryDraftKind = (typeof SUMMARY_DRAFT_KINDS)[number];

/** Вид задачи исполнителя: одна на заготовку, по разделу за шаг. */
export const CONTENT_DRAFT_TASK_KIND = 'content_draft';

/** Лимит операции по умолчанию - оценка этапа × 1,5, как у досье и сравнения. */
export const DRAFT_LIMIT_FACTOR = '1.5';

/** Заводка заготовки: операция, строка и задача - короткими INSERT (`L-020`). */
export const DRAFT_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/**
 * Умолчания этапов (`tech.md` §3: Claude, длинный контекст). Запасных в коде нет, как у досье:
 * их ставит редактор на экране «LLM settings».
 */
export const CONTENT_DRAFT_STAGE_DEFINITIONS: LlmStageDefinition[] = [
  {
    stage: SUMMARY_SECTIONS_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [],
    temperature: 0.3,
    maxTokens: 4_000,
    enabled: true,
  },
  {
    stage: SUMMARY_FULL_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [],
    temperature: 0.3,
    maxTokens: 16_000,
    enabled: true,
  },
  {
    stage: SUMMARY_BRIEF_STAGE,
    model: 'anthropic/claude-sonnet-5.5',
    fallbacks: [],
    temperature: 0.3,
    maxTokens: 6_000,
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

/** Окончательные отказы заготовки (`failedReason`). */
export const DRAFT_INVALID_RESPONSE = 'DRAFT_INVALID_RESPONSE';
/** Вход этапа не влезает в контекст модели или ответ длиннее предела поля. */
export const DRAFT_TOO_LONG = 'DRAFT_TOO_LONG';
/** В досье нет плана разделов. */
export const DRAFT_NO_PLAN = 'DRAFT_NO_PLAN';
/** Досье запуска переведённой версии удалено вместе с исходником. */
export const DRAFT_DOSSIER_MISSING = 'DRAFT_DOSSIER_MISSING';
/** Предпосылка пропала по ходу (разделы или полный удалены до шага). */
export const DRAFT_INPUT_MISSING = 'DRAFT_INPUT_MISSING';
/** Операцию отменили со страницы операций, а не кнопкой «discard». */
export const DRAFT_CANCELLED = 'DRAFT_CANCELLED';
