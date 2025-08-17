export interface CacheService {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const CACHE_SERVICE = Symbol('CACHE_SERVICE');
