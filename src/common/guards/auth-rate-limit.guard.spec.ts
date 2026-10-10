import { HttpException } from '@nestjs/common';
import {
  AuthRateLimitGuard,
  LOGIN_ACCOUNT_BUCKETS,
  LOGIN_IP_BUCKETS,
  loginLimitSubject,
  LOGOUT_IP_MAX,
} from './auth-rate-limit.guard';
import { InMemoryRateLimiter } from '../../shared/rate-limit/inmemory.rate-limiter';
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

    // Три корзины на попытку (`LEGACY-453`): узкая и аккаунта — одни на все варианты регистра.
    expect(consume).toHaveBeenCalledTimes(9);
    const keys = consume.mock.calls.map((call: unknown[]) => call[0]);
    expect(keys).toEqual(
      Array.from({ length: 3 }).flatMap(() => [
        'auth:login:203.0.113.1:victim@x.com',
        'auth:login-ip:203.0.113.1',
        'auth:login-account:victim@x.com',
      ]),
    );
  });

  it('нестроковый email или его отсутствие - корзина по одному IP', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume).canActivate(ctx('/api/auth/login', '203.0.113.1', { email: { a: 1 } }));
    await guard(consume).canActivate(ctx('/api/auth/login', '203.0.113.1', {}));

    // Без почты корзины аккаунта нет: только узкая (по одному IP) и общая адреса.
    expect(consume.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'auth:login:203.0.113.1',
      'auth:login-ip:203.0.113.1',
      'auth:login:203.0.113.1',
      'auth:login-ip:203.0.113.1',
    ]);
  });

  describe('перебор входа (LEGACY-453)', () => {
    /** Умолчания узкой корзины гарда: `RATE_LIMIT_LOGIN_MAX` и `RATE_LIMIT_LOGIN_WINDOW_MS`. */
    const LOGIN_MAX_DEFAULT = 5;
    const LOGIN_WINDOW_MS = 60_000;
    const LOGIN_IP_MAX = LOGIN_MAX_DEFAULT * LOGIN_IP_BUCKETS;
    const LOGIN_ACCOUNT_MAX = LOGIN_MAX_DEFAULT * LOGIN_ACCOUNT_BUCKETS;

    /** Настоящий лимитер: каждая корзина считает свои попытки, отказ точки не тратит. */
    const real = () => {
      const limiter = new InMemoryRateLimiter();
      return jest.fn((key: string, n: number, w: number, max: number) =>
        limiter.consume(key, n, w, max),
      );
    };
    const login = (g: AuthRateLimitGuard, ip: string, email: string) =>
      g.canActivate(ctx('/api/auth/login', ip, { email, password: 'x' }));

    it('один адрес по многим почтам упирается в потолок адреса', async () => {
      const g = guard(real());
      for (let i = 0; i < LOGIN_IP_MAX; i += 1) await login(g, '203.0.113.1', `u${i}@x.com`);
      await expect(login(g, '203.0.113.1', 'fresh@x.com')).rejects.toMatchObject({ status: 429 });
      // Соседний адрес своего бюджета не теряет.
      await expect(login(g, '203.0.113.2', 'fresh@x.com')).resolves.toBe(true);
    });

    it('один аккаунт со многих адресов упирается в корзину аккаунта', async () => {
      const g = guard(real());
      for (let i = 0; i < LOGIN_ACCOUNT_MAX; i += 1) await login(g, `198.51.100.${i}`, 'v@x.com');
      await expect(login(g, '198.51.100.250', 'v@x.com')).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({ retryAfter: LOGIN_WINDOW_MS / 1000 }),
      });
      await expect(login(g, '198.51.100.250', 'other@x.com')).resolves.toBe(true);
    });

    it('отказ узкой корзины не тратит корзину аккаунта — с одного адреса аккаунт не запереть', async () => {
      const consume = real();
      const g = guard(consume);
      for (let i = 0; i < LOGIN_ACCOUNT_MAX * 2; i += 1) {
        await login(g, '203.0.113.1', 'v@x.com').catch(() => undefined);
      }
      const accountCalls = consume.mock.calls.filter(
        (call: unknown[]) => call[0] === 'auth:login-account:v@x.com',
      );
      expect(accountCalls).toHaveLength(LOGIN_MAX_DEFAULT);
      await expect(login(g, '203.0.113.9', 'v@x.com')).resolves.toBe(true);
    });

    it('отказ корзины адреса не тратит корзину аккаунта', async () => {
      const consume = real();
      const g = guard(consume);
      for (let i = 0; i < LOGIN_IP_MAX; i += 1) await login(g, '203.0.113.1', `u${i}@x.com`);
      for (let i = 0; i < LOGIN_ACCOUNT_MAX; i += 1) {
        await login(g, '203.0.113.1', 'v@x.com').catch(() => undefined);
      }
      expect(
        consume.mock.calls.filter((call: unknown[]) => call[0] === 'auth:login-account:v@x.com'),
      ).toHaveLength(0);
    });

    it('свой RATE_LIMIT_LOGIN_MAX: потолки адреса и аккаунта растут вместе с узкой корзиной', async () => {
      const consume = jest.fn().mockResolvedValue(true);
      await guard(consume, { RATE_LIMIT_LOGIN_MAX: '15' }).canActivate(
        ctx('/api/auth/login', '203.0.113.1', { email: 'v@x.com' }),
      );
      expect(consume.mock.calls.map((call: unknown[]) => call[3])).toEqual([
        15,
        15 * LOGIN_IP_BUCKETS,
        15 * LOGIN_ACCOUNT_BUCKETS,
      ]);
    });

    it('вход с сервера Next без адреса посетителя общую корзину адреса не тратит (LEGACY-064)', async () => {
      const consume = jest.fn().mockResolvedValue(true);
      await guard(consume, { INTERNAL_PROXY_CIDRS: '10.0.0.0/8' }).canActivate(
        ctx('/api/auth/login', '10.0.0.5', { email: 'v@x.com' }),
      );
      expect(consume.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        'auth:login:10.0.0.5:v@x.com',
        'auth:login-account:v@x.com',
      ]);
    });

    it.each([
      ['IPv4 — как есть', '203.0.113.1', '203.0.113.1'],
      ['IPv6 — по /64', '2001:db8:aa:bb:1:2:3:4', '2001:db8:aa:bb::/64'],
      ['IPv6 со сжатием', '2001:db8::1', '2001:db8:0:0::/64'],
      ['IPv6 с ведущими нулями', '2001:0db8:00aa:0bb0::9', '2001:db8:aa:bb0::/64'],
      ['IPv4 в IPv6', '::ffff:203.0.113.1', '203.0.113.1'],
      ['не адрес — как есть', 'unknown', 'unknown'],
    ])('ключ адреса: %s', (_name, ip, subject) => {
      expect(loginLimitSubject(ip)).toBe(subject);
    });

    it('адреса одной IPv6 /64 делят корзину адреса и узкую корзину', async () => {
      const g = guard(real());
      for (let i = 0; i < LOGIN_IP_MAX; i += 1) {
        await login(g, `2001:db8:aa:bb::${(i + 1).toString(16)}`, `u${i}@x.com`);
      }
      await expect(login(g, '2001:db8:aa:bb::ffff', 'fresh@x.com')).rejects.toMatchObject({
        status: 429,
      });
      await expect(login(g, '2001:db8:aa:bc::1', 'fresh@x.com')).resolves.toBe(true);
    });

    // Решение арбитра 11.10.2026: окно аккаунта — окно входа. С окном в 15 минут один адрес,
    // шлющий по пять попыток в минуту, выбирал корзину аккаунта за шесть минут, и владелец
    // получал 429 со всех адресов.
    it('один адрес на пределе узкой корзины много окон подряд аккаунт не запирает', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-11T00:00:00Z'));
      try {
        const g = guard(real());
        for (let window = 0; window < 12; window += 1) {
          for (let i = 0; i < LOGIN_MAX_DEFAULT; i += 1) await login(g, '203.0.113.1', 'v@x.com');
          await expect(login(g, '198.51.100.7', 'v@x.com')).resolves.toBe(true);
          jest.setSystemTime(Date.now() + LOGIN_WINDOW_MS);
        }
      } finally {
        jest.useRealTimers();
      }
    });
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
