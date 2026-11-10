/**
 * Значение к хранимому виду: строки обрезаны, `''`, `null` и `undefined` у полей и элементов
 * выброшены («нет значения», `tech.md` §2), пустой массив или объект — `null` («блока нет», T5).
 * Экземпляры DTO превращаются в простые объекты — в JSON-колонку уходит только форма.
 */
export function compactBlock(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  // Дата — значение, а не объект с полями: иначе `Object.entries` пуст и даты SEO-события
  // выпадали бы из сравнения содержимого перевода.
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (Array.isArray(value)) {
    const items = value.map(compactBlock).filter((v) => v !== null);
    return items.length === 0 ? null : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const v = compactBlock(raw);
      if (v !== null) out[key] = v;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  return value;
}
