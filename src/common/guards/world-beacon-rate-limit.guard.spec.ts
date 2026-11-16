import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RateLimiter } from '../../shared/rate-limit/rate-limit.interface';
import { isBotUserAgent } from '../../shared/http/bot-user-agent';
import {
  WORLD_BEACON_LIMIT,
  WorldBeaconRateLimitGuard,
  worldBeaconLimitKey,
} from './world-beacon-rate-limit.guard';

/** Адрес сервера фронта — в `INTERNAL_PROXY_CIDRS`: ему верится `X-Visitor-IP`. */
const FRONT = '10.0.0.5';

function setup(allowed = true) {
  const consume = jest.fn().mockResolvedValue(allowed);
  const config = {
    get: jest.fn(
      (name: string) =>
        ({ INTERNAL_PROXY_CIDRS: '10.0.0.0/8', TRUSTED_PROXY_CIDRS: '192.0.2.0/24' })[name],
    ),
  };
  const guard = new WorldBeaconRateLimitGuard(
    config as unknown as ConfigService,
    { consume } as RateLimiter,
  );
  const header = jest.fn();
  const ctx = (ua: string | undefined, ip = '203.0.113.7', headers: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ ip, headers: { 'user-agent': ua, ...headers } }),
        getResponse: () => ({ header }),
      }),
    }) as unknown as ExecutionContext;
  return { guard, consume, header, ctx };
}

describe('WorldBeaconRateLimitGuard (F08-3a, решение арбитра Q5)', () => {
  it('ключ — хэш адреса с префиксом ручки, без сырого IP', () => {
    const key = worldBeaconLimitKey('203.0.113.7');
    expect(key).toMatch(/^world-beacon:[0-9a-f]{32}$/);
    expect(key).not.toContain('203.0.113.7');
    expect(worldBeaconLimitKey('203.0.113.8')).not.toBe(key);
  });

  it('событие посетителя — одно очко лимита по хэшу адреса', async () => {
    const { guard, consume, ctx } = setup();
    await expect(guard.canActivate(ctx('Mozilla/5.0'))).resolves.toBe(true);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(
      worldBeaconLimitKey('203.0.113.7'),
      1,
      WORLD_BEACON_LIMIT.windowMs,
      WORLD_BEACON_LIMIT.points,
    );
  });

  it('через прокси фронта — по адресу посетителя из X-Visitor-IP', async () => {
    const { guard, consume, ctx } = setup();
    // Фронт ходит в API через Cloudflare: сосед — адрес Cloudflare, `CF-Connecting-IP` — фронт.
    await guard.canActivate(
      ctx('Mozilla/5.0', '192.0.2.10', {
        'cf-connecting-ip': FRONT,
        'x-visitor-ip': '198.51.100.9',
      }),
    );
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0][0]).toBe(worldBeaconLimitKey('198.51.100.9'));
  });

  it('сервер фронта без адреса посетителя — без лимита, не одна корзина на весь сайт', async () => {
    const { guard, consume, ctx } = setup(false);
    await expect(guard.canActivate(ctx('Mozilla/5.0', FRONT))).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('бот лимит не тратит', async () => {
    const { guard, consume, ctx } = setup();
    await expect(guard.canActivate(ctx('Googlebot/2.1'))).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('сверх лимита — 429 с Retry-After', async () => {
    const { guard, header, ctx } = setup(false);
    const err = await guard.canActivate(ctx('Mozilla/5.0')).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    // Тело — как у `GlobalRateLimitGuard`.
    expect((err as { getResponse: () => unknown }).getResponse()).toMatchObject({
      statusCode: 429,
      retryAfter: WORLD_BEACON_LIMIT.windowMs / 1000,
    });
    expect(header).toHaveBeenCalledTimes(1);
    expect(header).toHaveBeenCalledWith('Retry-After', String(WORLD_BEACON_LIMIT.windowMs / 1000));
  });

  it('isBotUserAgent: боты, краулеры, безголовые браузеры; пустой агент — не бот', () => {
    for (const ua of ['Googlebot/2.1', 'bingbot', 'Yahoo! Slurp', 'HeadlessChrome/120', 'spider']) {
      expect({ ua, bot: isBotUserAgent(ua) }).toEqual({ ua, bot: true });
    }
    expect(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120')).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
  });
});
