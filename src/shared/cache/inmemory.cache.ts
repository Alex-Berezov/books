import { CacheService } from './cache.interface';

export class InMemoryCacheService implements CacheService {
  private store = new Map<string, { value: unknown; expireAt?: number }>();

  get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (entry.expireAt && entry.expireAt < Date.now()) {
      this.store.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expireAt = ttlMs ? Date.now() + ttlMs : undefined;
    this.store.set(key, { value, expireAt });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}
