import { InMemoryCacheService } from './inmemory.cache';

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
});
