import { ContentDraftKind } from '@prisma/client';

/**
 * Задача автозапуска раздела по `done` языка запуска (`F06-5`; `features/F06-summary-autofill/tech.md`
 * §4): LLM не зовёт, резерв бюджета не проходит, зовёт старт хода и закрывает свою операцию.
 */
export const CONTENT_AUTOSTART_TASK_KIND = 'content_autostart';

/**
 * Причины, по которым операция автозапуска закрыта без хода (`LlmOperation.skipReason`, решение
 * арбитра `F06 | F06-5`, Р3). Их ровно три (Р6): прочие отказы старта - строка хода `failed`.
 */
export const AUTOSTART_SKIPPED_EXISTING = 'AUTOSTART_SKIPPED_EXISTING';
export const AUTOSTART_SKIPPED_IN_PROGRESS = 'AUTOSTART_SKIPPED_IN_PROGRESS';
export const AUTOSTART_SKIPPED_LLM_DISABLED = 'AUTOSTART_SKIPPED_LLM_DISABLED';

/** Второй автозапуск того же языка и вида: тихий выход, не причина (`tech.md` §4 п.3). */
export const AUTOSTART_DUPLICATE = 'AUTOSTART_DUPLICATE';

export const AUTOSTART_SKIP_REASONS = [
  AUTOSTART_SKIPPED_EXISTING,
  AUTOSTART_SKIPPED_IN_PROGRESS,
  AUTOSTART_SKIPPED_LLM_DISABLED,
] as const;

export type AutostartSkipReason = (typeof AUTOSTART_SKIP_REASONS)[number];

/**
 * Причины состояния раздела языка, которые не пишутся в базу, а выводятся из операции автозапуска
 * (`run/run-summary.ts`): тихих статусов без причины нет (`tech.md` §4 п.4).
 */
export const AUTOSTART_FAILED = 'AUTOSTART_FAILED';
export const AUTOSTART_CANCELLED = 'AUTOSTART_CANCELLED';
export const AUTOSTART_NOTHING_TO_START = 'AUTOSTART_NOTHING_TO_START';

/** Виды раздела, которые стартуют сами (`F07-3` добавит анализ). */
export type AutostartKind = Extract<ContentDraftKind, 'summary_write'>;

/**
 * Ключ пары задачи автозапуска - свой: никогда не ключ запуска и языка (`pairKeyOf`), его держит
 * сама задача языка, которая в момент `done` ещё `running` (`tech.md` §4 п.1).
 */
export function autostartPairKey(translationRunLanguageId: string, kind: AutostartKind): string {
  return `autostart:${translationRunLanguageId}:${kind}`;
}
