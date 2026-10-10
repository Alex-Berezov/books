import { timingSafeEqual } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { MetricsAccessGuard, metricsTokenMatches } from './metrics-access.guard';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

/** `LEGACY-455`: токен метрик сверяется за время, не зависящее от совпавшего префикса. */
describe('metricsTokenMatches', () => {
  it('совпадение и расхождение, в том числе по длине', () => {
    expect(metricsTokenMatches('secret-token', 'secret-token')).toBe(true);
    expect(metricsTokenMatches('secret-tokeX', 'secret-token')).toBe(false);
    expect(metricsTokenMatches('secret', 'secret-token')).toBe(false);
    expect(metricsTokenMatches('', 'secret-token')).toBe(false);
  });

  it('сравнение идёт через timingSafeEqual, а не ===', () => {
    (timingSafeEqual as jest.Mock).mockClear();
    metricsTokenMatches('a', 'b');
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});

describe('MetricsAccessGuard: METRICS_TOKEN', () => {
  const guard = new MetricsAccessGuard(
    {
      get: (key: string) => (key === 'METRICS_TOKEN' ? 'scrape-secret' : undefined),
    } as unknown as ConfigService,
    {} as ModeratorRolesService,
  );
  const ctx = (authorization: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
    }) as unknown as ExecutionContext;

  it.each([
    ['неверный токен той же длины', 'Bearer scrape-secreX'],
    ['токен другой длины', 'Bearer scrape'],
    ['не Bearer', 'Basic scrape-secret'],
  ])('%s — путь METRICS_TOKEN не открывает, идёт проверка JWT', async (_name, header) => {
    const jwtPath = jest
      .spyOn(
        Object.getPrototypeOf(MetricsAccessGuard.prototype) as {
          canActivate: () => Promise<boolean>;
        },
        'canActivate',
      )
      .mockResolvedValue(false);
    await expect(guard.canActivate(ctx(header))).resolves.toBe(false);
    expect(jwtPath).toHaveBeenCalledTimes(1);
    jwtPath.mockRestore();
  });

  it('пустой METRICS_TOKEN маршрут не открывает даже пустым bearer', async () => {
    const open = new MetricsAccessGuard(
      { get: () => '' } as unknown as ConfigService,
      {} as ModeratorRolesService,
    );
    const jwtPath = jest
      .spyOn(
        Object.getPrototypeOf(MetricsAccessGuard.prototype) as {
          canActivate: () => Promise<boolean>;
        },
        'canActivate',
      )
      .mockResolvedValue(false);
    await expect(open.canActivate(ctx('Bearer '))).resolves.toBe(false);
    jwtPath.mockRestore();
  });

  it('верный токен открывает маршрут, и сравнение идёт через timingSafeEqual', async () => {
    (timingSafeEqual as jest.Mock).mockClear();
    await expect(guard.canActivate(ctx('Bearer scrape-secret'))).resolves.toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
