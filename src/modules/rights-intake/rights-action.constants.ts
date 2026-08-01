/**
 * WP-5 — жизненный цикл `RightsAction`.
 *
 * До WP-5 статус действия записывался один раз при материализации отчёта и не изменялся
 * нигде: блокирующее действие мог закрыть только агент своим отчётом, человек — никогда
 * (R3-02, R3-03). Константы ниже задают, что вправе предложить агент, что вправе сделать
 * человек и какие действия влияют на правовой вердикт по стране.
 */

/** Статусы, которые внешний агент вправе предложить в `requiredActions[].suggestedStatus`. */
export const AGENT_SUGGESTABLE_ACTION_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;

/**
 * Статусы, в которых действие считается закрытым.
 *
 * Совпадает с условиями approve (`rights-approval.service.ts`), создания книги
 * (`rights-book-creation.service.ts`) и блока гейта 6.12 (`publication-gate.service.ts`):
 * `CANCELLED` закрытым **не** считается — отменённое обязательное действие продолжает
 * блокировать публикацию.
 */
export const RESOLVED_ACTION_STATUSES = ['COMPLETED', 'WAIVED'] as const;

/**
 * Разрешённые переходы статуса — белым списком (R4-04: чёрные списки не знают о новых
 * значениях). Возврат из терминального статуса разрешён: он строго ужесточает состояние —
 * ранее закрытое действие снова начинает блокировать публикацию.
 */
export const ACTION_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PENDING: ['IN_PROGRESS', 'COMPLETED', 'WAIVED', 'CANCELLED'],
  IN_PROGRESS: ['PENDING', 'COMPLETED', 'WAIVED', 'CANCELLED'],
  COMPLETED: ['PENDING', 'IN_PROGRESS'],
  WAIVED: ['PENDING', 'IN_PROGRESS'],
  CANCELLED: ['PENDING', 'IN_PROGRESS'],
};

/**
 * Типы действий, означающих физическое удаление или замену компонента издания.
 *
 * Пока хотя бы одно такое действие открыто, компонент, помеченный к удалению, продолжает
 * учитываться в оценке страны: правовой вердикт не может опираться на обещание (R6-06).
 * Связи «действие → компонент» в модели нет (в отчёте агента её тоже нет), поэтому условие
 * профильное: удаления считаются подтверждёнными, когда закрыты **все** такие действия.
 */
export const COMPONENT_REMOVAL_ACTION_TYPES = [
  'REMOVE_COMPONENT',
  'REPLACE_COMPONENT',
  'REMOVE_GUTENBERG_HEADER',
  'REMOVE_GUTENBERG_FOOTER',
  'REMOVE_GUTENBERG_LICENSE',
  'REPLACE_COVER',
  'REPLACE_ILLUSTRATIONS',
] as const;

/**
 * Подтверждены ли удаления компонентов для профиля.
 *
 * `false`, если действий на удаление нет вовсе: компонент помечен к удалению, но
 * подтвердить факт нечем — это fail-closed сторона.
 */
export const areComponentRemovalsConfirmed = (
  actions: Array<{ actionType: string; status: string }>,
): boolean => {
  const removalActions = actions.filter((action) =>
    (COMPONENT_REMOVAL_ACTION_TYPES as readonly string[]).includes(action.actionType),
  );

  return (
    removalActions.length > 0 &&
    removalActions.every((action) =>
      (RESOLVED_ACTION_STATUSES as readonly string[]).includes(action.status),
    )
  );
};
