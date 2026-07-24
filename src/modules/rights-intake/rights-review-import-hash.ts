import { createHash } from 'crypto';

export function stableJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
