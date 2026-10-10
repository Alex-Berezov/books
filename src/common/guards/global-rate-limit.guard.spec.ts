import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { GlobalRateLimitGuard } from './global-rate-limit.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RateLimiter } from '../../shared/rate-limit/rate-limit.interface';
import { sessionStateCache } from '../../shared/session/session-state-cache';

/**
 * Обход глобального лимита модератором (`LEGACY-453`, дописка `T122`): подписи мало —
 * погашенный токен (выход, пароль, роли, блокировка) обхода не получает.
 */
describe('GlobalRateLimitGuard: обход лимита модератором только живой сессией', () => {
  const secret = 'access-secret';
  const jwt = new JwtService();
  let consume: jest.Mock;
  let findUnique: jest.Mock;
  let guard: GlobalRateLimitGuard;

  const ctx = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          ip: '203.0.113.10',
          path: '/api/books',
          headers: authorization ? { authorization } : {},
        }),
        getResponse: () => ({ header: jest.fn() }),
      }),
    }) as unknown as ExecutionContext;

  const bearer = (claims: Record<string, unknown>) =>
    `Bearer ${jwt.sign({ sub: 'u-admin', ...claims }, { secret })}`;

  beforeEach(() => {
    sessionStateCache.clear();
    consume = jest.fn().mockResolvedValue(false);
    findUnique = jest.fn();
    const values: Record<string, string> = {
      RATE_LIMIT_GLOBAL_ENABLED: '1',
      JWT_ACCESS_SECRET: secret,
    };
    const config = { get: (name: string) => values[name] } as unknown as ConfigService;
    guard = new GlobalRateLimitGuard(config, { consume } as unknown as RateLimiter, jwt, {
      user: { findUnique },
    } as unknown as PrismaService);
  });

  afterAll(() => sessionStateCache.clear());

  it('живая сессия админа — мимо лимита', async () => {
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 2 });
    await expect(guard.canActivate(ctx(bearer({ roles: ['admin'], tv: 2 })))).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    ['версия токена погашена', { isActive: true, tokenVersion: 3 }],
    ['пользователь заблокирован', { isActive: false, tokenVersion: 2 }],
    ['пользователя нет', null],
  ])('%s — запрос считается, лимит отвечает 429', async (_name, state) => {
    findUnique.mockResolvedValue(state);
    await expect(guard.canActivate(ctx(bearer({ roles: ['admin'], tv: 2 })))).rejects.toMatchObject(
      { status: 429 },
    );
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('content_manager с живой сессией — тоже мимо лимита', async () => {
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 0 });
    await expect(
      guard.canActivate(ctx(bearer({ roles: ['content_manager'], tv: 0 }))),
    ).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([
    ['версия в базе 0 — живёт', 0, true],
    ['версия в базе поднята — считается', 1, false],
  ])('токен без tv (выдан до T122): %s', async (_name, tokenVersion, bypass) => {
    findUnique.mockResolvedValue({ isActive: true, tokenVersion });
    const result = guard.canActivate(ctx(bearer({ roles: ['admin'] })));
    if (bypass) await expect(result).resolves.toBe(true);
    else await expect(result).rejects.toMatchObject({ status: 429 });
  });

  it('база не ответила — не 500, запрос считается как обычный', async () => {
    findUnique.mockRejectedValue(new Error('connection refused'));
    await expect(guard.canActivate(ctx(bearer({ roles: ['admin'], tv: 0 })))).rejects.toMatchObject(
      {
        status: 429,
      },
    );
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('состояние сессии берётся из общего кэша: второй запрос в базу не ходит', async () => {
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 0 });
    const header = bearer({ roles: ['admin'], tv: 0 });
    await guard.canActivate(ctx(header));
    await guard.canActivate(ctx(header));
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['заголовка нет', undefined],
    ['не Bearer', 'Basic abc'],
    ['мусор вместо токена', 'Bearer not-a-jwt'],
  ])('%s — 429, а не 500, база не трогается', async (_name, header) => {
    await expect(guard.canActivate(ctx(header))).rejects.toMatchObject({ status: 429 });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('токен без роли модератора в базу не ходит и считается', async () => {
    await expect(guard.canActivate(ctx(bearer({ roles: ['user'], tv: 0 })))).rejects.toMatchObject({
      status: 429,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('чужая подпись — считается, база не трогается', async () => {
    const forged = `Bearer ${jwt.sign({ sub: 'u-admin', roles: ['admin'] }, { secret: 'other' })}`;
    await expect(guard.canActivate(ctx(forged))).rejects.toMatchObject({ status: 429 });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
