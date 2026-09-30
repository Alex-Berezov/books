import { Prisma } from '@prisma/client';
import {
  parseJsonStringArray,
  parseRelatedSlugs,
  RELATED_SLUG_KEYS,
  type RelatedSlugKey,
} from './json-string-array.util';

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

describe('parseRelatedSlugs (LEGACY-417, T74)', () => {
  const row = (over: Partial<Record<RelatedSlugKey, Prisma.JsonValue | null>> = {}) => ({
    id: 'tr-1',
    name: 'Tag',
    relatedTagSlugs: null as Prisma.JsonValue | null,
    relatedGenreSlugs: null as Prisma.JsonValue | null,
    relatedCategorySlugs: null as Prisma.JsonValue | null,
    relatedCollectionSlugs: null as Prisma.JsonValue | null,
    ...over,
  });

  it('разбирает все четыре колонки и не трогает остальные поля строки', () => {
    const parsed = parseRelatedSlugs(
      row({
        relatedTagSlugs: ['a', 1] as unknown as Prisma.JsonValue,
        relatedGenreSlugs: { not: 'an array' },
        relatedCategorySlugs: [],
        relatedCollectionSlugs: ['c'],
      }),
    );

    expect(parsed).toEqual({
      id: 'tr-1',
      name: 'Tag',
      relatedTagSlugs: ['a'],
      relatedGenreSlugs: null,
      relatedCategorySlugs: [],
      relatedCollectionSlugs: ['c'],
    });
  });

  it('пустые колонки дают null, а не пустой массив', () => {
    const parsed = parseRelatedSlugs(row());

    for (const key of RELATED_SLUG_KEYS) expect(parsed[key]).toBeNull();
  });
});
