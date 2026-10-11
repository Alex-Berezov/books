import { evictBounded } from '../cache/bounded-map';
import { RateLimiter } from './rate-limit.interface';

/**
 * Потолок числа корзин (`LEGACY-460`). Ключ корзины несёт IP и значения из запроса
 * (`auth:logout:<ip>:<subject>`): без потолка карта растёт по числу разных ключей.
 */
export const INMEMORY_RATE_LIMITER_MAX_BUCKETS = 100_000;

/** Вытеснение до 90 %, а не ровно до потолка: иначе каждая новая корзина снова упирается в него. */
const EVICT_DOWN_TO = Math.floor(INMEMORY_RATE_LIMITER_MAX_BUCKETS * 0.9);

/**
 * Лимитер с фиксированным окном, на процесс. При упоре в потолок сначала снимаются корзины
 * с истёкшим окном — они ничего не ограничивают; затем старейшие по созданию.
 *
 * ⚠️ Цена потолка (решение арбитра T126 11.10.2026, `decisions-log.md`; тело `LEGACY-460`):
 * поток из ~100 000 новых ключей вытесняет и живые корзины, в том числе исчерпанное окно
 * перебора — оно начинается заново. Ранжирование по расходу не годится: один экземпляр держит
 * ключи с разными пределами, а предел корзина не хранит.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { resetAt: number; used: number }>();

  consume(key: string, points: number, intervalMs: number, maxPoints: number): Promise<boolean> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // Новое окно переносит ключ в конец порядка вставки.
      this.buckets.delete(key);
      if (this.buckets.size >= INMEMORY_RATE_LIMITER_MAX_BUCKETS) this.evict(now);
      this.buckets.set(key, { resetAt: now + intervalMs, used: points });
      return Promise.resolve(true);
    }
    if (bucket.used + points <= maxPoints) {
      bucket.used += points;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(now: number): void {
    evictBounded(this.buckets, EVICT_DOWN_TO, (bucket) => bucket.resetAt <= now);
  }
}
