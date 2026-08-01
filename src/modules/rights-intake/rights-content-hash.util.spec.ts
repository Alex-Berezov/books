import {
  RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
  stableCanonicalize,
  stableStringify,
  sha256Hex,
} from './rights-content-hash.util';

describe('RightsContentHashUtil', () => {
  describe('stableCanonicalize', () => {
    it('should sort object keys', () => {
      const input = { b: 2, a: 1, c: 3 };
      const result = stableCanonicalize(input) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
    });

    it('should handle nested objects', () => {
      const input = { z: { b: 2, a: 1 }, y: 3 };
      const canonical = stableCanonicalize(input) as Record<string, unknown>;
      expect(Object.keys(canonical['z'] as Record<string, unknown>)).toEqual(['a', 'b']);
    });

    it('should remove undefined values', () => {
      const input = { a: 1, b: undefined, c: null };
      const result = stableCanonicalize(input) as Record<string, unknown>;
      expect(result).toEqual({ a: 1, c: null });
    });

    it('should serialize Date to ISO string', () => {
      const date = new Date('2026-01-01T00:00:00.000Z');
      const result = stableCanonicalize({ date }) as Record<string, unknown>;
      expect(result['date']).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should preserve array order', () => {
      const input = { items: [3, 1, 2] };
      const result = stableCanonicalize(input) as Record<string, unknown>;
      expect(result['items']).toEqual([3, 1, 2]);
    });

    it('should handle null', () => {
      expect(stableCanonicalize(null)).toBeNull();
    });

    it('should handle undefined', () => {
      expect(stableCanonicalize(undefined)).toBeNull();
    });

    it('should handle primitive values', () => {
      expect(stableCanonicalize(42)).toBe(42);
      expect(stableCanonicalize('hello')).toBe('hello');
      expect(stableCanonicalize(true)).toBe(true);
      expect(stableCanonicalize(false)).toBe(false);
    });
  });

  describe('stableStringify', () => {
    it('should produce stable JSON string', () => {
      const input = { b: 2, a: 1 };
      const result = stableStringify(input);
      expect(result).toBe('{"a":1,"b":2}');
    });

    it('should produce identical hash for same objects with different key order', () => {
      const a = stableStringify({ name: 'test', value: 42 });
      const b = stableStringify({ value: 42, name: 'test' });
      expect(a).toBe(b);
    });

    it('should produce different hash for different chapter content', () => {
      const a = stableStringify({ chapters: [{ number: 1, content: 'Hello world' }] });
      const b = stableStringify({ chapters: [{ number: 1, content: 'Goodbye world' }] });
      expect(a).not.toBe(b);
    });

    it('should preserve array order', () => {
      const a = stableStringify({ arr: [1, 2, 3] });
      const b = stableStringify({ arr: [3, 2, 1] });
      expect(a).not.toBe(b);
    });
  });

  describe('sha256Hex', () => {
    it('should return 64 character hex string', () => {
      const hash = sha256Hex('test');
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });

    it('should be deterministic', () => {
      const a = sha256Hex('hello');
      const b = sha256Hex('hello');
      expect(a).toBe(b);
    });

    it('should produce different hashes for different inputs', () => {
      const a = sha256Hex('hello');
      const b = sha256Hex('world');
      expect(a).not.toBe(b);
    });
  });

  describe('RIGHTS_CONTENT_HASH_ALGORITHM_VERSION', () => {
    // WP-7: состав входа изменился (права издания — записью на язык), версия алгоритма — V2.
    it('should be RIGHTS_CONTENT_HASH_V2', () => {
      expect(RIGHTS_CONTENT_HASH_ALGORITHM_VERSION).toBe('RIGHTS_CONTENT_HASH_V2');
    });
  });

  describe('integration: stableStringify + sha256Hex', () => {
    it('should produce same hash for same data with different key order', () => {
      const data1 = { title: 'Test', author: 'Author', chapters: [{ n: 1, c: 'text' }] };
      const data2 = { author: 'Author', chapters: [{ c: 'text', n: 1 }], title: 'Test' };

      const hash1 = sha256Hex(stableStringify(data1));
      const hash2 = sha256Hex(stableStringify(data2));

      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for different content', () => {
      const data1 = { title: 'Test', content: 'A' };
      const data2 = { title: 'Test', content: 'B' };

      const hash1 = sha256Hex(stableStringify(data1));
      const hash2 = sha256Hex(stableStringify(data2));

      expect(hash1).not.toBe(hash2);
    });

    it('should include algorithm version in hash input', () => {
      const input = { algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION, data: 'test' };
      const hash = sha256Hex(stableStringify(input));
      expect(hash).toBeTruthy();
      expect(hash).toHaveLength(64);
    });

    it('should handle null/undefined fields consistently', () => {
      const withNull = stableStringify({ a: null, b: 1 });
      const withoutField = stableStringify({ b: 1 });
      // null is preserved, undefined is removed
      expect(withNull).not.toBe(withoutField);
    });
  });
});
