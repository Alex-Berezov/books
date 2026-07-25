import { createHash } from 'crypto';

export const RIGHTS_CONTENT_HASH_ALGORITHM_VERSION = 'RIGHTS_CONTENT_HASH_V1';

export function stableCanonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(stableCanonicalize);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const val = obj[key];
      if (val !== undefined) {
        result[key] = stableCanonicalize(val);
      }
    }
    return result;
  }

  return value;
}

export function stableStringify(value: unknown): string {
  const canonical = stableCanonicalize(value);
  return JSON.stringify(canonical, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = obj[key];
    }
    return result;
  }
  return value;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}
