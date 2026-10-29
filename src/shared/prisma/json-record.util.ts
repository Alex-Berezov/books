/**
 * Объект с ключами, прочитанный из `Json`-колонки или из ответа модели: `null` и массив
 * в JSON тоже `object`, поэтому оба отсекаются явно. Один помощник на все разборы Json
 * по полям, а не копия в каждом модуле.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
