import { isRecord } from './json-record.util';

describe('isRecord', () => {
  it('accepts a plain object and an object without a prototype', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('rejects null, arrays and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
    expect(isRecord('{}')).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});
