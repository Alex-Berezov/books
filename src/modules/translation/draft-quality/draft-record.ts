import { isRecord } from '../../../shared/prisma/json-record.util';
import { ReviewState } from './quality-loop';
import { DraftRemark, DraftRemarkCode } from './text-checks';

/**
 * Чтение записей хода из `ContentDraft.data` - общее для пересказа и анализа. Форма проверяется
 * на чтении: что не той формы, отбрасывается (замечание) или даёт `null` (итог проверки).
 */

export const stringOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const intOf = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

export const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

/** Читатель списка замечаний: свой перечень кодов у каждого хода (пересказ и анализ различаются). */
export function remarksReader(codes: readonly DraftRemarkCode[]) {
  const one = (v: unknown): DraftRemark[] => {
    if (!isRecord(v)) return [];
    const code = oneOf<DraftRemarkCode>(codes, v.code);
    const by = oneOf(['code', 'model'] as const, v.by);
    const where = stringOf(v.where);
    const note = stringOf(v.note);
    return code && by && where !== null && note !== null ? [{ code, where, note, by }] : [];
  };
  return (v: unknown): DraftRemark[] => (Array.isArray(v) ? v.flatMap(one) : []);
}

/** Читатель итога проверяющей: перечень видов свой у каждого хода. */
export function reviewReader(kinds: readonly ReviewState['kind'][]) {
  return (v: unknown): ReviewState | null => {
    if (!isRecord(v)) return null;
    const kind = oneOf(kinds, v.kind);
    if (kind === 'answered') {
      const model = stringOf(v.model);
      return model === null ? null : { kind, model };
    }
    return kind === null ? null : { kind };
  };
}

/**
 * Сериализация с ключами по алфавиту на каждом уровне: jsonb переставляет ключи объекта (Л2),
 * поэтому отпечаток не зависит от порядка ключей. `undefined` у ключа - как отсутствие ключа.
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
