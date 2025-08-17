export interface RateLimiter {
  consume(key: string, points: number, intervalMs: number, maxPoints: number): Promise<boolean>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');
