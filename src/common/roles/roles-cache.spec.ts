import { Role } from '../decorators/roles.decorator';
import { ROLES_CACHE_MAX_ENTRIES, rolesCache } from './roles-cache';

/**
 * Срок жизни, сброс и потолок записей (`LEGACY-112`). Ключ кэша — `userId`,
 * поэтому без потолка карта растёт по числу когда-либо заходивших пользователей.
 */

const roles = new Set<Role>([Role.Admin]);

/** Обычная запись: чтение началось в текущем поколении и им же закончилось. */
const put = (userId: string, exp: number, now: number): void => {
  rolesCache.set(userId, roles, exp, now, rolesCache.beginRead());
};

describe('rolesCache', () => {
  beforeEach(() => rolesCache.clear());
  afterAll(() => rolesCache.clear());

  it('отдаёт записанное, пока не вышел срок', () => {
    put('u1', 1_000, 0);
    expect(rolesCache.get('u1', 999)).toEqual(roles);
  });

  it('просроченную запись не отдаёт и не хранит', () => {
    put('u1', 1_000, 0);
    expect(rolesCache.get('u1', 1_000)).toBeUndefined();
    expect(rolesCache.size).toBe(0);
  });

  it('invalidate убирает запись до истечения срока', () => {
    put('u1', 1_000, 0);
    rolesCache.invalidate('u1');
    expect(rolesCache.get('u1', 0)).toBeUndefined();
  });

  it('invalidate по отсутствующему ключу ничего не ломает', () => {
    expect(() => rolesCache.invalidate('нет такого')).not.toThrow();
    expect(rolesCache.size).toBe(0);
  });

  describe('гонка чтения и сброса', () => {
    it('чтение, начатое до сброса, в кэш не ложится', () => {
      // Запрос вошёл в гвард и промахнулся по кэшу...
      const readGeneration = rolesCache.beginRead();
      // ...пока он ходил в базу, роль отозвали...
      rolesCache.invalidate('u1');
      // ...и он записывает устаревший ответ.
      rolesCache.set('u1', roles, 60_000, 0, readGeneration);

      expect(rolesCache.get('u1', 0)).toBeUndefined();
      expect(rolesCache.size).toBe(0);
    });

    it('сброс чужого пользователя тоже отбрасывает чтение — счётчик общий', () => {
      const readGeneration = rolesCache.beginRead();
      rolesCache.invalidate('другой');
      rolesCache.set('u1', roles, 60_000, 0, readGeneration);
      expect(rolesCache.get('u1', 0)).toBeUndefined();
    });

    it('чтение, начатое после сброса, ложится как обычно', () => {
      rolesCache.invalidate('u1');
      put('u1', 60_000, 0);
      expect(rolesCache.get('u1', 0)).toEqual(roles);
    });
  });

  describe('потолок', () => {
    it('не растёт выше потолка даже на живых записях', () => {
      for (let i = 0; i < ROLES_CACHE_MAX_ENTRIES + 500; i += 1) put(`u${i}`, 10_000, 0);

      expect(rolesCache.size).toBeLessThanOrEqual(ROLES_CACHE_MAX_ENTRIES);
      // Вытесняются самые старые, последние записи на месте.
      expect(rolesCache.get(`u${ROLES_CACHE_MAX_ENTRIES + 499}`, 0)).toEqual(roles);
      expect(rolesCache.get('u0', 0)).toBeUndefined();
    });

    it('вытесняет с запасом, а не по одной записи на каждую вставку', () => {
      for (let i = 0; i < ROLES_CACHE_MAX_ENTRIES; i += 1) put(`u${i}`, 10_000, 0);
      const before = rolesCache.size;

      put('перелив', 10_000, 0);

      // Ровно до потолка вытеснять нельзя: следующая вставка снова упрётся
      // в него, и каждый промах кэша начнёт обходить всю карту дважды.
      expect(rolesCache.size).toBeLessThan(before);
    });

    it('сначала выбрасывает просроченные, а не живые', () => {
      for (let i = 0; i < ROLES_CACHE_MAX_ENTRIES; i += 1) put(`stale${i}`, 100, 0);
      put('fresh', 10_000, 200);

      expect(rolesCache.size).toBe(1);
      expect(rolesCache.get('fresh', 200)).toEqual(roles);
    });
  });

  it('перезапись того же пользователя не плодит записей', () => {
    put('u1', 1_000, 0);
    rolesCache.set('u1', new Set<Role>([Role.User]), 2_000, 0, rolesCache.beginRead());
    expect(rolesCache.size).toBe(1);
    expect(rolesCache.get('u1', 0)).toEqual(new Set([Role.User]));
  });
});
