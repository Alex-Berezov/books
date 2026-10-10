/**
 * Кэш состояния сессии пользователя — `isActive` и `tokenVersion` (`LEGACY-451`, `LEGACY-452`),
 * общий на процесс.
 *
 * `JwtStrategy.validate` сверяет каждый access-токен с базой: заблокированный пользователь и токен
 * со старой версией получают 401. Без кэша это был бы запрос на каждый авторизованный вызов;
 * с кэшем — окно до `ROLES_CACHE_TTL_MS` (по умолчанию 5 с), в которое снятое состояние
 * ещё действует **на другом экземпляре** приложения. На своём экземпляре запись сбрасывается
 * сразу же после записи в базу (`invalidate`). Решение арбитра 10.10.2026, `decisions-log.md`.
 *
 * ⚠️ Устроен по образцу `src/common/roles/roles-cache.ts` и с ним **не слит**: так велели
 * границы того же решения арбитра («`RolesCache` не менять и в общий класс с новым кэшем
 * не сливать», решение арбитра T122 10.10.2026, `books-app-docs/ai-context/decisions-log.md`). Общее у них — синглтон
 * на процесс, а не поле стратегии; потолок записей; поколения `beginRead`/`set` против
 * гонки «чтение до сброса — запись после сброса», которая возвращала бы в кэш уже погашенную
 * версию на весь TTL. Починка поколений или вытеснения в одном кэше требует той же во втором.
 * TTL общий: `readRolesCacheTtlMs` из `roles-cache.ts`.
 */

export type SessionState = { isActive: boolean; tokenVersion: number };

/** Потолок числа записей: ключ — `userId`, без потолка карта растёт по числу входивших. */
export const SESSION_STATE_CACHE_MAX_ENTRIES = 5000;

/** Вытеснение до 90 %, а не ровно до потолка: иначе каждый промах снова упирается в него. */
const EVICT_DOWN_TO = Math.floor(SESSION_STATE_CACHE_MAX_ENTRIES * 0.9);

type Entry = { state: SessionState; exp: number };

class SessionStateCache {
  private readonly entries = new Map<string, Entry>();

  /** Растёт на каждом сбросе; чтение, начатое до сброса, в кэш не попадает. */
  private generation = 0;

  /** Отметка «читаю из базы»; значение отдаётся обратно в `set`. */
  beginRead(): number {
    return this.generation;
  }

  get(userId: string, now: number): Readonly<SessionState> | undefined {
    const entry = this.entries.get(userId);
    if (!entry) return undefined;
    if (entry.exp <= now) {
      this.entries.delete(userId);
      return undefined;
    }
    return entry.state;
  }

  set(userId: string, state: SessionState, exp: number, now: number, readGeneration: number): void {
    if (readGeneration !== this.generation) return;
    this.entries.delete(userId);
    if (this.entries.size >= SESSION_STATE_CACHE_MAX_ENTRIES) this.evict(now);
    this.entries.set(userId, { state, exp });
  }

  /** Зовётся после записи `isActive` или `tokenVersion` — вне транзакции, после коммита. */
  invalidate(userId: string): void {
    this.entries.delete(userId);
    this.generation += 1;
  }

  /** Полный сброс. Нужен спекам: состояние общее на процесс и течёт между ними. */
  clear(): void {
    this.entries.clear();
    this.generation += 1;
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [userId, entry] of this.entries) {
      if (entry.exp <= now) this.entries.delete(userId);
    }
    for (const userId of this.entries.keys()) {
      if (this.entries.size <= EVICT_DOWN_TO) break;
      this.entries.delete(userId);
    }
  }
}

export const sessionStateCache = new SessionStateCache();
