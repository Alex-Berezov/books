import { isRecord } from '../prisma/json-record.util';

/**
 * Сериализация с ключами по алфавиту на каждом уровне: jsonb переставляет ключи объекта (Л2),
 * поэтому отпечаток не зависит от порядка ключей. `undefined` у ключа - как отсутствие ключа.
 * Общая для отпечатков заготовок хода (`draft-quality`) и сравнения содержания мира книги (F08-1, R9).
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
