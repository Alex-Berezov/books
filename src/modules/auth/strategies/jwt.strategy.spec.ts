import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../../prisma/prisma.service';
import { sessionStateCache } from '../../../shared/session/session-state-cache';

/**
 * 🔴 `LEGACY-451`, `LEGACY-452`. До `T122` `validate` возвращал поля токена, не заходя в базу:
 * заблокированный пользователь и токен, погашенный выходом или сменой пароля, работали
 * до конца своих 15 минут. Посадки держат три отказа и кэш, без которого проверка была бы
 * запросом в базу на каждый авторизованный вызов.
 */
describe('JwtStrategy.validate (LEGACY-451, LEGACY-452)', () => {
  let findUnique: jest.Mock;
  let strategy: JwtStrategy;

  function build(ttlMs = '5000'): JwtStrategy {
    const config = {
      get: (key: string) =>
        ({ JWT_ACCESS_SECRET: 'access-secret-for-spec', ROLES_CACHE_TTL_MS: ttlMs })[key],
    };
    return new JwtStrategy(
      config as unknown as ConfigService,
      { user: { findUnique } } as unknown as PrismaService,
    );
  }

  beforeEach(() => {
    sessionStateCache.clear();
    findUnique = jest.fn().mockResolvedValue({ isActive: true, tokenVersion: 3 });
    strategy = build();
  });

  afterAll(() => sessionStateCache.clear());

  it('живая сессия: отдаёт userId и email, читает только состояние сессии', async () => {
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 })).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.c',
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { isActive: true, tokenVersion: true },
    });
  });

  it('версия токена отстала от базы — 401', async () => {
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 2 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('токен без tv (выдан до T122) — версия 0', async () => {
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 0 });
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c' })).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.c',
    });
    sessionStateCache.clear();
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 1 });
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('заблокированный пользователь — 401 при совпавшей версии', async () => {
    findUnique.mockResolvedValue({ isActive: false, tokenVersion: 3 });
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('пользователя нет — 401, отсутствие не кэшируется', async () => {
    findUnique.mockResolvedValue(null);
    await expect(strategy.validate({ sub: 'gone', email: 'a@b.c', tv: 0 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionStateCache.size).toBe(0);
  });

  it('повторный вызов в пределах TTL в базу не ходит', async () => {
    await strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 });
    await strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('сброс кэша после записи — следующий вызов видит новую версию', async () => {
    await strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 });
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 4 });
    sessionStateCache.invalidate('u1');
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('сброс кэша во время чтения из базы: прочитанное старое состояние в кэш не попадает', async () => {
    // Выход поднял версию и сбросил кэш, пока чтение этой стратегии было в пути.
    findUnique.mockImplementationOnce(() => {
      sessionStateCache.invalidate('u1');
      return Promise.resolve({ isActive: true, tokenVersion: 3 });
    });
    await strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 });

    // Следующий запрос обязан прочитать базу заново, а не взять устаревшую версию из кэша.
    findUnique.mockResolvedValue({ isActive: true, tokenVersion: 4 });
    await expect(strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('TTL 0 — кэша нет, каждый вызов читает базу', async () => {
    strategy = build('0');
    await strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 });
    await strategy.validate({ sub: 'u1', email: 'a@b.c', tv: 3 });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
