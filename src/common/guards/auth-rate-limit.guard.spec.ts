import { HttpException } from '@nestjs/common';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
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

  // Control landing 5 (CR auth-social). The `else` branch used to `return true`,
  // so /auth/social — the very route that hands out sessions — was outside every
  // limit, and so is any auth route added later. "Unrecognised → allow" is the
  // same defect shape as "no robots directive → index".
  it('landing 5: /auth/social is counted', async () => {
    const consume = jest.fn().mockResolvedValue(true);
    await guard(consume).canActivate(ctx('/api/auth/social'));

    expect(consume).toHaveBeenCalledWith('auth:other:203.0.113.10', 1, 60_000, 10);
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
