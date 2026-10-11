/**
 * Вытеснение из карты с потолком (`LEGACY-460`): общее для `InMemoryCacheService`
 * и `InMemoryRateLimiter`, чтобы правило «что уходит первым» было одним.
 *
 * Порядок: сначала все истёкшие записи — они уже ничего не значат; затем, пока размер выше
 * `downTo`, старейшие по вставке (`Map` хранит порядок вставки). Один проход, без сортировки.
 *
 * ⚠️ `session-state-cache.ts` и `roles-cache.ts` держат свои копии намеренно — решение
 * арбитра T122 10.10.2026 (`decisions-log.md`) не сливать их ни между собой, ни с новыми кэшами.
 */
export function evictBounded<K, V>(
  map: Map<K, V>,
  downTo: number,
  isExpired: (value: V) => boolean,
): void {
  for (const [key, value] of map) {
    if (isExpired(value)) map.delete(key);
  }
  for (const key of map.keys()) {
    if (map.size <= downTo) return;
    map.delete(key);
  }
}
