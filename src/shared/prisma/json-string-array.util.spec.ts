import { Prisma } from '@prisma/client';
import { parseJsonStringArray } from './json-string-array.util';

describe('parseJsonStringArray', () => {
  it('returns null for null and undefined', () => {
    expect(parseJsonStringArray(null)).toBeNull();
    expect(parseJsonStringArray(undefined)).toBeNull();
  });

  it('returns the array as-is when every element is a string', () => {
    expect(parseJsonStringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseJsonStringArray([])).toEqual([]);
  });

  it('drops a non-array Json value to null', () => {
    expect(parseJsonStringArray({ foo: 'bar' } as Prisma.JsonValue)).toBeNull();
    expect(parseJsonStringArray('just a string' as Prisma.JsonValue)).toBeNull();
  });

  it('filters out non-string elements instead of dropping the whole array', () => {
    expect(parseJsonStringArray([1, 2, 3] as unknown as Prisma.JsonValue)).toEqual([]);
    expect(parseJsonStringArray(['ok', 1] as unknown as Prisma.JsonValue)).toEqual(['ok']);
  });
});
