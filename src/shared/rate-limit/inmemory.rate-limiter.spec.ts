import { INMEMORY_RATE_LIMITER_MAX_BUCKETS, InMemoryRateLimiter } from './inmemory.rate-limiter';

describe('InMemoryRateLimiter (unit)', () => {
  const base = new Date('2025-01-01T00:00:00Z').getTime();
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(base);
    limiter = new InMemoryRateLimiter();
  });

  afterEach(() => jest.useRealTimers());

  it('limits within the window and resets after it', async () => {
    await expect(limiter.consume('k', 1, 1000, 2)).resolves.toBe(true);
    await expect(limiter.consume('k', 1, 1000, 2)).resolves.toBe(true);
    await expect(limiter.consume('k', 1, 1000, 2)).resolves.toBe(false);
    jest.setSystemTime(base + 1000);
    await expect(limiter.consume('k', 1, 1000, 2)).resolves.toBe(true);
  });

  // LEGACY-460: ключ корзины несёт значения из запроса — карта не растёт выше потолка.
  it('never grows above the cap', async () => {
    for (let i = 0; i < INMEMORY_RATE_LIMITER_MAX_BUCKETS * 2; i += 1) {
      await limiter.consume(`k${i}`, 1, 60_000, 1);
    }
    expect(limiter.size).toBeLessThanOrEqual(INMEMORY_RATE_LIMITER_MAX_BUCKETS);
  });

  it('drops buckets with an expired window before live ones', async () => {
    const half = INMEMORY_RATE_LIMITER_MAX_BUCKETS / 2;
    for (let i = 0; i < half; i += 1) await limiter.consume(`expired${i}`, 1, 1, 1);
    jest.setSystemTime(base + 10);
    for (let i = 0; i < half; i += 1) await limiter.consume(`live${i}`, 1, 60_000, 1);
    expect(limiter.size).toBe(INMEMORY_RATE_LIMITER_MAX_BUCKETS);

    await limiter.consume('overflow', 1, 60_000, 1);
    // Истёкших хватило: ни одна живая корзина не вытеснена, старейшая живая держит лимит.
    expect(limiter.size).toBe(half + 1);
    await expect(limiter.consume('live0', 1, 60_000, 1)).resolves.toBe(false);
  });

  it('a full limiter keeps limiting the newest keys', async () => {
    for (let i = 0; i < INMEMORY_RATE_LIMITER_MAX_BUCKETS; i += 1) {
      await limiter.consume(`k${i}`, 1, 60_000, 1);
    }
    await expect(limiter.consume('new', 1, 60_000, 1)).resolves.toBe(true);
    await expect(limiter.consume('new', 1, 60_000, 1)).resolves.toBe(false);
    expect(limiter.size).toBeLessThanOrEqual(INMEMORY_RATE_LIMITER_MAX_BUCKETS);
  });
});
