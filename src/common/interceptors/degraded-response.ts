/**
 * Признак ответа, собранного по неполным данным.
 *
 * 🔴 `LEGACY-305`. `LEGACY-277` сознательно оставила публичному резолверу SEO
 * право отвечать 200 с неполным JSON-LD: крошки, жанры, рейтинг и отзывы для
 * страницы необязательны, и ронять из-за них публичный маршрут нельзя. Но
 * обработчик кэшируется (`public, s-maxage=300, stale-while-revalidate=3600`),
 * поэтому обеднённый ответ, собранный в момент секундного отказа базы, уезжал
 * на общий кэш и раздавался всем следующим до конца TTL — уже без записи в лог,
 * потому что сервис второй раз не звался. `Logger.warn` показывал **один**
 * случай деградации, а страниц с обеднённой разметкой поисковик видел столько,
 * сколько их запросят за час.
 *
 * ⚠️ Ключ — символ, а не поле. Поле `degraded` в теле ответа попало бы
 * в контракт: в `books-front/types/api-schema` и в `api-contracts.md`, — и
 * потребовало бы парной правки фронта ради служебного признака. Символ
 * не сериализуется `JSON.stringify` вовсе, поэтому тело ответа не меняется
 * ни на байт. Решение арбитра от 29.08.2026, строка в `decisions-log.md`.
 */
export const DEGRADED_RESPONSE = Symbol('degradedResponse');

/**
 * Пометить собранный ответ как деградировавший.
 *
 * Свойство неперечислимое и по символьному ключу: ни `JSON.stringify`,
 * ни `Object.keys`, ни спред его не увидят. Снимает метку
 * `PublicCacheInterceptor` — он же и переводит ответ на короткий кэш.
 */
export function markDegraded<T extends object>(bundle: T): T {
  Object.defineProperty(bundle, DEGRADED_RESPONSE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return bundle;
}

/**
 * Помечен ли ответ как деградировавший. Метка при этом снимается: она
 * служебная и дальше интерцептора не живёт.
 */
export function takeDegradedMark(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const holder = value as Record<symbol, unknown>;
  if (holder[DEGRADED_RESPONSE] !== true) return false;
  delete holder[DEGRADED_RESPONSE];
  return true;
}
