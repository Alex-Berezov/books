/**
 * Языки, одобренные анкетой прав (`RightsIntake.targetLanguages`, JSON). Не массив или пустой
 * список - `null`: нет читаемого списка - нет ни одного разрешённого языка (WP-10.9, R2-03).
 * Один предикат на ручное создание версии и выбор целей перевода (решение арбитра
 * `F05 | F05-2`, В8): перевод не получает языка, которого не получила бы ручная версия.
 */
export function approvedTargetLanguages(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}
