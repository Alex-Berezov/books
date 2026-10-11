import { INMEMORY_CACHE_MAX_ENTRIES, InMemoryCacheService } from './inmemory.cache';

describe('InMemoryCacheService (unit)', () => {
  let cache: InMemoryCacheService;

  beforeEach(() => {
    cache = new InMemoryCacheService();
  });

  it('set/get/del basic flow', async () => {
    await cache.set('k', { a: 1 });
    await expect(cache.get('k')).resolves.toEqual({ a: 1 });
    await cache.del('k');
    await expect(cache.get('k')).resolves.toBeUndefined();
  });

  it('respects TTL and expires entries', async () => {
    jest.useFakeTimers();
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    jest.setSystemTime(base);

    await cache.set('ttl', 'v', 1000);
    await expect(cache.get('ttl')).resolves.toBe('v');

    // advance beyond ttl
    jest.setSystemTime(base + 1001);
    await expect(cache.get('ttl')).resolves.toBeUndefined();

    jest.useRealTimers();
  });

  it('no TTL keeps value available', async () => {
    jest.useFakeTimers();
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    jest.setSystemTime(base);

    await cache.set('persist', 42);
    jest.setSystemTime(base + 10_000);
    await expect(cache.get('persist')).resolves.toBe(42);

    jest.useRealTimers();
  });

  // LEGACY-460: ключи из ввода анонима — карта не растёт выше потолка.
  it('never grows above the cap; evicts expired first, then the oldest', async () => {
    jest.useFakeTimers();
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    jest.setSystemTime(base);

    await cache.set('expired', 'x', 1);
    await cache.set('oldest', 'o');
    await cache.set('fresh-ttl', 'f', 60_000);
    jest.setSystemTime(base + 10);
    for (let i = 0; i < INMEMORY_CACHE_MAX_ENTRIES * 2; i += 1) {
      await cache.set(`k${i}`, i, 60_000);
      expect(cache.size).toBeLessThanOrEqual(INMEMORY_CACHE_MAX_ENTRIES);
    }
    await expect(cache.get('expired')).resolves.toBeUndefined();
    await expect(cache.get('oldest')).resolves.toBeUndefined();
    await expect(cache.get(`k${INMEMORY_CACHE_MAX_ENTRIES * 2 - 1}`)).resolves.toBe(
      INMEMORY_CACHE_MAX_ENTRIES * 2 - 1,
    );

    jest.useRealTimers();
  });

  it('rewriting a key keeps it from being evicted as the oldest', async () => {
    await cache.set('hot', 1);
    for (let i = 0; i < INMEMORY_CACHE_MAX_ENTRIES - 1; i += 1) await cache.set(`k${i}`, i);
    await cache.set('hot', 2);
    await cache.set('overflow', 0);
    await expect(cache.get('hot')).resolves.toBe(2);
    await expect(cache.get('k0')).resolves.toBeUndefined();
  });

  it('drops expired entries before older live ones', async () => {
    jest.useFakeTimers();
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    jest.setSystemTime(base);

    // Живая запись — старейшая по вставке, истёкшие вставлены после неё.
    await cache.set('live-oldest', 'keep');
    for (let i = 0; i < INMEMORY_CACHE_MAX_ENTRIES - 1; i += 1) await cache.set(`e${i}`, i, 1);
    jest.setSystemTime(base + 10);
    await cache.set('overflow', 0);

    await expect(cache.get('live-oldest')).resolves.toBe('keep');
    expect(cache.size).toBe(2);

    jest.useRealTimers();
  });
});
