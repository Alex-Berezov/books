import { ContentDraftKind } from '@prisma/client';

/**
 * Задача автозапуска раздела по `done` языка запуска (`F06-5`; `features/F06-summary-autofill/tech.md`
 * §4): LLM не зовёт, резерв бюджета не проходит, зовёт старт хода и закрывает свою операцию.
 */
export const CONTENT_AUTOSTART_TASK_KIND = 'content_autostart';

/**
 * Задача автозапуска хода анализа (`F07-3b`) - свой вид на тот же обработчик (решение арбитра
 * `F07 | F07-3b`, /qa круг 1): прежний образ забирает только свои виды задач (`claim(kinds)`), и
 * при откате по тегу эта задача ждёт, а не стартует пересказ.
 */
export const ANALYSIS_AUTOSTART_TASK_KIND = 'content_autostart_analysis';

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
 * (`run/run-sections.ts`): тихих статусов без причины нет (`tech.md` §4 п.4).
 */
export const AUTOSTART_FAILED = 'AUTOSTART_FAILED';
export const AUTOSTART_CANCELLED = 'AUTOSTART_CANCELLED';
export const AUTOSTART_NOTHING_TO_START = 'AUTOSTART_NOTHING_TO_START';

/** Виды раздела, которые стартуют сами (`F06-5`, `F07-3b`). */
export type AutostartKind = Extract<ContentDraftKind, 'summary_write' | 'analysis_write'>;

/** Вид задачи автозапуска по виду хода раздела. */
export const AUTOSTART_TASK_KINDS: Readonly<Record<AutostartKind, string>> = {
  summary_write: CONTENT_AUTOSTART_TASK_KIND,
  analysis_write: ANALYSIS_AUTOSTART_TASK_KIND,
};

/** Виды хода раздела, которые стартуют сами, - ключи `AUTOSTART_TASK_KINDS`, один список на все места. */
export const AUTOSTART_KINDS = Object.keys(AUTOSTART_TASK_KINDS) as AutostartKind[];

/**
 * Вид хода по виду задачи - обратной таблицей `AUTOSTART_TASK_KINDS`: `content_autostart` -
 * пересказ, в том числе задачи прежнего образа (решения арбитра `F07 | F07-3b`). Чужой вид -
 * ошибка регистрации обработчика, а не повод стартовать пересказ.
 */
export function autostartKindOfTask(taskKind: string): AutostartKind {
  const kind = AUTOSTART_KINDS.find((k) => AUTOSTART_TASK_KINDS[k] === taskKind);
  if (!kind) throw new Error(`Autostart handler got a task of kind ${taskKind}`);
  return kind;
}

/**
 * Ключ пары задачи автозапуска - свой: никогда не ключ запуска и языка (`pairKeyOf`), его держит
 * сама задача языка, которая в момент `done` ещё `running` (`tech.md` §4 п.1).
 */
export function autostartPairKey(translationRunLanguageId: string, kind: AutostartKind): string {
  return `autostart:${translationRunLanguageId}:${kind}`;
}
