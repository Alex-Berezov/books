import { claimedTokenVersion, isSessionAlive, unverifiedTokenSubject } from './session-token';

describe('session-token (LEGACY-451, LEGACY-452)', () => {
  it.each([
    [{ isActive: true, tokenVersion: 2 }, { tv: 2 }, true],
    [{ isActive: true, tokenVersion: 2 }, { tv: 1 }, false],
    [{ isActive: false, tokenVersion: 2 }, { tv: 2 }, false],
    [null, { tv: 0 }, false],
    [{ isActive: true, tokenVersion: 0 }, {}, true],
    [{ isActive: true, tokenVersion: 1 }, {}, false],
  ])('isSessionAlive(%j, %j) = %p', (state, claims, alive) => {
    expect(isSessionAlive(state, claims)).toBe(alive);
  });

  it('токен без tv (выдан до T122) — версия 0', () => {
    expect(claimedTokenVersion({})).toBe(0);
    expect(claimedTokenVersion({ tv: 3 })).toBe(3);
  });

  it.each([
    [`h.${Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')}.s`, 'u1'],
    [
      `h.${Buffer.from(JSON.stringify({ sub: 'x'.repeat(100) })).toString('base64url')}.s`,
      'x'.repeat(64),
    ],
    [`h.${Buffer.from(JSON.stringify({ sub: 1 })).toString('base64url')}.s`, ''],
    ['not-a-jwt', ''],
    ['h.@@@.s', ''],
    [undefined, ''],
  ])('unverifiedTokenSubject(%p) = %p', (token, sub) => {
    expect(unverifiedTokenSubject(token)).toBe(sub);
  });
});
