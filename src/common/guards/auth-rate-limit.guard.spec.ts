import { HttpException } from '@nestjs/common';
import { AuthRateLimitGuard, LOGOUT_IP_MAX } from './auth-rate-limit.guard';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

function ctx(path: string, ip = '203.0.113.10', body: Record<string, unknown> = {}) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip, path, body }) }),
  } as unknown as ExecutionContext;
}

function guard(consume: jest.Mock, values: Record<string, string> = {}) {
  const config = {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
  const limiter = { consume } as unknown as RateLimiter;
  return new AuthRateLimitGuard(config, limiter);
}

describe('AuthRateLimitGuard', () => {
  it('counts login attempts', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume).canActivate(ctx('/api/auth/login', '203.0.113.1', { email: 'a@b.c' }));

    expect(consume).toHaveBeenCalledWith('auth:login:203.0.113.1:a@b.c', 1, 60_000, 5);
  });

  // 🔴 LEGACY-443: вход ищет адрес в нижнем регистре, значит и корзина лимита - одна на все
  // варианты регистра. Иначе каждый вариант `Victim@x.com` давал свои пять попыток к одному хешу.
  it('варианты регистра и пробелы одного адреса делят одну корзину', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    for (const email of ['Victim@X.com', ' vIctim@x.COM ', 'victim@x.com']) {
      await guard(consume).canActivate(ctx('/api/auth/login', '203.0.113.1', { email }));
    }

    expect(consume).toHaveBeenCalledTimes(3);
    for (const call of consume.mock.calls) {
      expect(call[0]).toBe('auth:login:203.0.113.1:victim@x.com');
    }
  });

  it('нестроковый email или его отсутствие - корзина по одному IP', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume).canActivate(ctx('/api/auth/login', '203.0.113.1', { email: { a: 1 } }));
    await guard(consume).canActivate(ctx('/api/auth/login', '203.0.113.1', {}));

    expect(consume).toHaveBeenCalledTimes(2);
    for (const call of consume.mock.calls) expect(call[0]).toBe('auth:login:203.0.113.1');
  });

  // Control landing 5 (CR auth-social). The `else` branch used to `return true`,
  // so /auth/social — the very route that hands out sessions — was outside every
  // limit, and so is any auth route added later. "Unrecognised → allow" is the
  // same defect shape as "no robots directive → index".
  it('landing 5: /auth/social is counted', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume).canActivate(ctx('/api/auth/social'));

    expect(consume).toHaveBeenCalledWith('auth:other:203.0.113.10', 1, 60_000, 10);
  });

  /** Неподписанный JWT: корзине выхода нужен только `sub`, подпись проверяет сервис. */
  const jwtWithSub = (sub: unknown) =>
    `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;

  it('выход (LEGACY-451): две корзины — потолок адреса и адрес плюс sub, не общие с /auth/social', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    const g = guard(consume);
    await g.canActivate(ctx('/api/auth/logout', '203.0.113.1', { refreshToken: jwtWithSub('u1') }));

    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume.mock.calls[0]).toEqual(['auth:logout:203.0.113.1', 1, 60_000, LOGOUT_IP_MAX]);
    expect(consume.mock.calls[1]).toEqual(['auth:logout:203.0.113.1:u1', 1, 60_000, 10]);
  });

  it('выход с телом без JWT считается в корзины адреса, а не проходит мимо', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    const g = guard(consume);
    await g.canActivate(ctx('/api/auth/logout', '203.0.113.1', {}));
    await g.canActivate(ctx('/api/auth/logout', '203.0.113.1', { refreshToken: 'garbage' }));
    await g.canActivate(ctx('/api/auth/logout', '203.0.113.1', { refreshToken: jwtWithSub(42) }));

    expect(consume).toHaveBeenCalledTimes(6);
    const keys = consume.mock.calls.map((call: unknown[]) => call[0]);
    expect(keys).toEqual([
      'auth:logout:203.0.113.1',
      'auth:logout:203.0.113.1:',
      'auth:logout:203.0.113.1',
      'auth:logout:203.0.113.1:',
      'auth:logout:203.0.113.1',
      'auth:logout:203.0.113.1:',
    ]);
  });

  it('подделка sub не даёт новых бюджетов сверх потолка адреса — 429', async () => {
    // Настоящий счёт: каждая корзина считает свои попытки.
    const counts = new Map<string, number>();
    const consume = jest.fn((key: string, _n: number, _w: number, max: number) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next <= max);
    });
    const g = guard(consume);

    for (let i = 0; i < LOGOUT_IP_MAX; i += 1) {
      await g.canActivate(
        ctx('/api/auth/logout', '203.0.113.1', { refreshToken: jwtWithSub(`forged-${i}`) }),
      );
    }
    await expect(
      g.canActivate(
        ctx('/api/auth/logout', '203.0.113.1', { refreshToken: jwtWithSub('one-more') }),
      ),
    ).rejects.toMatchObject({ status: 429 });
    // Корзина нового `sub` при этом не тронута: отказ дал потолок адреса.
    expect(counts.has('auth:logout:203.0.113.1:one-more')).toBe(false);
  });

  it('landing 5: an unknown path under /auth is counted', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume).canActivate(ctx('/api/auth/whatever-comes-next'));

    expect(consume).toHaveBeenCalledTimes(1);
  });

  // The catch-all key must not contain the path: otherwise walking made-up
  // paths under /auth hands out a fresh budget for each one.
  it('landing 5: made-up paths share one budget', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    const g = guard(consume);

    await g.canActivate(ctx('/api/auth/aaa'));
    await g.canActivate(ctx('/api/auth/bbb'));

    const keys = consume.mock.calls.map((call) => call[0] as string);
    expect(new Set(keys).size).toBe(1);
  });

  it('landing 5: refuses once the catch-all budget is spent', async () => {
    const consume = jest.fn().mockResolvedValue(false);

    await expect(guard(consume).canActivate(ctx('/api/auth/social'))).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('honours the catch-all limits from configuration', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume, {
      RATE_LIMIT_AUTH_DEFAULT_MAX: '3',
      RATE_LIMIT_AUTH_DEFAULT_WINDOW_MS: '5000',
    }).canActivate(ctx('/api/auth/social'));

    expect(consume).toHaveBeenCalledWith('auth:other:203.0.113.10', 1, 5000, 3);
  });

  it('stays disabled when RATE_LIMIT_AUTH_ENABLED=0', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume, { RATE_LIMIT_AUTH_ENABLED: '0' }).canActivate(ctx('/api/auth/social'));

    expect(consume).not.toHaveBeenCalled();
  });
});
