import { evictBounded } from './bounded-map';
import { CacheService } from './cache.interface';

/**
 * Потолок числа записей (`LEGACY-460`). Ключи строятся из ввода анонима (`GET /views/aggregate`,
 * `GET /likes/count`): без потолка карта растёт до падения процесса по памяти.
 */
export const INMEMORY_CACHE_MAX_ENTRIES = 10_000;

/** Вытеснение до 90 %, а не ровно до потолка: иначе каждая новая запись снова упирается в него. */
const EVICT_DOWN_TO = Math.floor(INMEMORY_CACHE_MAX_ENTRIES * 0.9);

/**
 * Кэш на экземпляр. Истёкшие записи снимаются при чтении своего ключа и разом при упоре в потолок;
 * если истёкших не хватило, вытесняются старейшие по вставке (`evictBounded`). Таймера нет: чистка
 * привязана к записи, процесс ей не держится.
 *
 * ⚠️ Вытесняется любая запись, поэтому то, что терять нельзя, в общий экземпляр `CacheModule` не
 * кладётся: upload-токены живут в своём экземпляре `UploadsModule`, иначе поток анонимных ключей
 * `GET /views/aggregate` вытеснял бы их, и загрузка получала бы 401.
 */
export class InMemoryCacheService implements CacheService {
  private store = new Map<string, { value: unknown; expireAt?: number }>();

  get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (entry.expireAt && entry.expireAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const now = Date.now();
    const expireAt = ttlMs ? now + ttlMs : undefined;
    // Перезапись ключа переносит его в конец порядка вставки — «старейшим» он больше не считается.
    this.store.delete(key);
    if (this.store.size >= INMEMORY_CACHE_MAX_ENTRIES) this.evict(now);
    this.store.set(key, { value, expireAt });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  get size(): number {
    return this.store.size;
  }

  private evict(now: number): void {
    evictBounded(this.store, EVICT_DOWN_TO, (entry) => !!entry.expireAt && entry.expireAt <= now);
  }
}
