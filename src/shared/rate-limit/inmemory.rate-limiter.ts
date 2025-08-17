import { RateLimiter } from './rate-limit.interface';

export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { resetAt: number; used: number }>();

  consume(key: string, points: number, intervalMs: number, maxPoints: number): Promise<boolean> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { resetAt: now + intervalMs, used: points });
      return Promise.resolve(true);
    }
    if (bucket.used + points <= maxPoints) {
      bucket.used += points;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}
