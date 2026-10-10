import { SESSION_STATE_CACHE_MAX_ENTRIES, sessionStateCache } from './session-state-cache';

const ALIVE = { isActive: true, tokenVersion: 0 };

describe('sessionStateCache (LEGACY-451, LEGACY-452)', () => {
  beforeEach(() => sessionStateCache.clear());
  afterAll(() => sessionStateCache.clear());

  it('отдаёт запись до срока и забывает после', () => {
    sessionStateCache.set('u1', ALIVE, 1000, 0, sessionStateCache.beginRead());
    expect(sessionStateCache.get('u1', 999)).toEqual(ALIVE);
    expect(sessionStateCache.get('u1', 1000)).toBeUndefined();
  });

  it('чтение, начатое до сброса, в кэш не попадает', () => {
    // Запрос ушёл в базу за версией 0, тем временем выход поднял её и сбросил кэш.
    const readGeneration = sessionStateCache.beginRead();
    sessionStateCache.invalidate('u1');
    sessionStateCache.set('u1', ALIVE, 1000, 0, readGeneration);
    expect(sessionStateCache.get('u1', 0)).toBeUndefined();
  });

  it('invalidate снимает только названного', () => {
    sessionStateCache.set('u1', ALIVE, 1000, 0, sessionStateCache.beginRead());
    sessionStateCache.set('u2', ALIVE, 1000, 0, sessionStateCache.beginRead());
    sessionStateCache.invalidate('u1');
    expect(sessionStateCache.get('u1', 0)).toBeUndefined();
    expect(sessionStateCache.get('u2', 0)).toEqual(ALIVE);
  });

  it('не растёт выше потолка', () => {
    for (let i = 0; i <= SESSION_STATE_CACHE_MAX_ENTRIES; i += 1) {
      sessionStateCache.set(`u${i}`, ALIVE, 1000, 0, sessionStateCache.beginRead());
    }
    expect(sessionStateCache.size).toBeLessThanOrEqual(SESSION_STATE_CACHE_MAX_ENTRIES);
    // Свежая запись пережила вытеснение, старейшая — нет.
    expect(sessionStateCache.get(`u${SESSION_STATE_CACHE_MAX_ENTRIES}`, 0)).toEqual(ALIVE);
    expect(sessionStateCache.get('u0', 0)).toBeUndefined();
  });
});
