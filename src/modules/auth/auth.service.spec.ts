import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JsonWebTokenError, TokenExpiredError } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { AuthService, ENV_BOOTSTRAP_AUDIT_SOURCE } from './auth.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { SocialIdentityService } from './providers/social-identity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import {
  AdminAuditAction,
  AdminAuditTargetType,
  RoleName,
  Language as PrismaLanguage,
  User,
} from '@prisma/client';
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_USER_SELECT } from '../../common/selects/account-user.select';
import { stripComments } from '../../common/testing/module-registration';
import { sessionStateCache } from '../../shared/session/session-state-cache';

jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

interface PrismaStub {
  role: { upsert: jest.Mock; findUnique: jest.Mock };
  user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  userRole: { upsert: jest.Mock; findMany: jest.Mock };
  userIdentity: { findUnique: jest.Mock; upsert: jest.Mock };
  $transaction: jest.Mock;
}

/**
 * Клиент транзакции — **отдельный** объект, а не сам `prisma`: только так посадка отличает
 * запись тем же `tx` от записи корневым клиентом (урок `T20`, `LEGACY-015`).
 */
interface TxStub {
  user: { create: jest.Mock; update: jest.Mock };
  role: { findMany: jest.Mock };
  userRole: { createMany: jest.Mock };
  userIdentity: { upsert: jest.Mock };
}

interface JwtStub {
  signAsync: jest.Mock;
  verifyAsync: jest.Mock;
  decode: jest.Mock;
}

interface ConfigStub {
  get: jest.Mock;
}

interface SocialStub {
  verify: jest.Mock;
}

/** Аргумент обращения к делегату `user`: тесты смотрят только на `select`. */
type UserCallArgs = { select?: Record<string, boolean> };

describe('AuthService (unit)', () => {
  let service: AuthService;
  let prisma: PrismaStub;
  let jwt: JwtStub;
  let config: ConfigStub;
  let social: SocialStub;
  let tx: TxStub;
  let adminAudit: { record: jest.Mock };

  const now = new Date('2025-01-01T00:00:00Z');
  const user: User = {
    id: 'u1',
    email: 'user@example.com',
    passwordHash: 'hash',
    name: 'John',
    isActive: true,
    tokenVersion: 0,
    avatarUrl: null,
    languagePreference: PrismaLanguage.en,
    createdAt: now,
    lastLogin: null,
  } as User;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      role: { upsert: jest.fn(), findUnique: jest.fn() },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        // Отметка входа отдаёт версию сессий на момент подписи (`markSignIn`).
        update: jest.fn().mockResolvedValue({ tokenVersion: 0 }),
        updateMany: jest.fn(),
      },
      userRole: { upsert: jest.fn(), findMany: jest.fn() },
      // Привязка личности провайдера. По умолчанию её нет — так выглядит первый
      // вход после миграции, когда `providerUserId` прошлых входов нигде не сохранён.
      userIdentity: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (client: TxStub) => Promise<unknown>)(tx)
          : Promise.resolve(arg),
      ),
    };
    tx = {
      // Отдельный мок, пробрасывающий в `prisma.user.create`: сторожа белого списка
      // (`LEGACY-190`) смотрят на `prisma.user.*`, а посадка T43 — на то, что создание шло через `tx`.
      // `update` и `upsert` привязки пробрасываются туда же: соцвход пишет отметку входа,
      // привязку и профиль одной транзакцией, а сценарные проверки смотрят на `prisma.*`.
      user: {
        create: jest.fn((args: unknown) => prisma.user.create(args) as Promise<unknown>),
        update: jest.fn((args: unknown) => prisma.user.update(args) as Promise<unknown>),
      },
      userIdentity: {
        upsert: jest.fn((args: unknown) => prisma.userIdentity.upsert(args) as Promise<unknown>),
      },
      role: {
        findMany: jest.fn((args: { where: { name: { in: string[] } } }) =>
          Promise.resolve(args.where.name.in.map((name) => ({ id: `r-${name}`, name }))),
        ),
      },
      userRole: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    jwt = {
      signAsync: jest.fn().mockResolvedValueOnce('acc').mockResolvedValueOnce('ref'),
      verifyAsync: jest.fn(),
      decode: jest.fn(),
    };
    config = {
      get: jest.fn((k: string) => {
        const map: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a',
          JWT_REFRESH_SECRET: 'r',
          JWT_ACCESS_EXPIRES_IN: '15m',
          JWT_REFRESH_EXPIRES_IN: '7d',
          ADMIN_EMAILS: '',
          CONTENT_MANAGER_EMAILS: '',
        };
        return map[k];
      }),
    };
    social = { verify: jest.fn() };
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      social as unknown as SocialIdentityService,
      adminAudit as unknown as AdminAuditService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('register: conflict on existing email', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    await expect(
      service.register({ email: user.email, password: 'p', name: 'n' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('register: версия сессий в токенах — из отметки входа, запись только живой строке', async () => {
    (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce(user);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValueOnce({ tokenVersion: 3 });

    await service.register({ email: user.email, password: 'p', name: 'n' });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0]).toEqual({
      where: { id: user.id, isActive: true },
      data: { lastLogin: now },
      select: { tokenVersion: true },
    });
    expect(jwt.signAsync).toHaveBeenCalledTimes(2);
    for (const [payload] of jwt.signAsync.mock.calls as [{ tv: number }][]) {
      expect(payload.tv).toBe(3);
    }
  });

  it('login: заблокированный с неверным паролем получает «Invalid credentials», а не «disabled»', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ ...user, isActive: false });
    (argon2.verify as jest.Mock).mockResolvedValueOnce(false);

    await expect(service.login({ email: user.email, password: 'wrong' })).rejects.toThrow(
      'Invalid credentials',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('register: success, assigns roles and returns tokens', async () => {
    (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
    prisma.user.findUnique.mockResolvedValueOnce(null); // no existing
    prisma.user.create.mockResolvedValueOnce(user);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

    const res = await service.register({ email: user.email, password: 'p', name: 'n' });
    expect(prisma.user.create).toHaveBeenCalled();
    expect(tx.userRole.createMany).toHaveBeenCalledTimes(1);
    expect(tx.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: user.id, roleId: `r-${RoleName.user}` }],
      skipDuplicates: true,
    });
    expect(res.user.email).toBe(user.email);
    expect(res.user.roles).toEqual(['user']); // should include roles now
    expect(res.accessToken).toBe('acc');
    expect(res.refreshToken).toBe('ref');
  });

  /**
   * 🔴 `LEGACY-443` (решение арбитра 08.10.2026). Регистрация паролем адрес не доказывает,
   * поэтому адрес из `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` получает только `user`:
   * иначе незанятый адрес из списка отдавал админа первому, кто его зарегистрировал.
   * Бутстрап первого администратора живёт на соцвходе с подтверждённым адресом
   * (блок ниже) и в `prisma/seed.ts`. Вернут выдачу в `register()` — тест краснеет.
   */
  it('register: почта из ADMIN_EMAILS роль admin не получает, только user', async () => {
    config.get = jest.fn((k: string) => {
      const map: Record<string, string> = {
        JWT_ACCESS_SECRET: 'a',
        JWT_REFRESH_SECRET: 'r',
        ADMIN_EMAILS: user.email,
        CONTENT_MANAGER_EMAILS: user.email,
      };
      return map[k];
    });
    (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce(user);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

    await service.register({ email: user.email, password: 'p', name: 'n' });

    const grantedRoleIds = tx.userRole.createMany.mock.calls.map(
      (call: [{ data: Array<{ roleId: string }> }]) => call[0].data[0].roleId,
    );
    expect(grantedRoleIds).toEqual([`r-${RoleName.user}`]);
    expect(adminAudit.record).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-015`, пачка `T43` (решение арбитра 27.09.2026): выдача повышенной роли
   * по env-списку при регистрации — шестой путь смены ролей, и он пишет `ROLE_ASSIGNED`
   * той же транзакцией. Базовая `user` события не получает; повтор (`count === 0`) — тоже.
   */
  describe('соцвход: роли по env-спискам и журнал выдачи (LEGACY-015, T43; LEGACY-443)', () => {
    const withEnv = (admins: string, managers: string) => {
      config.get = jest.fn((k: string) => {
        const map: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a',
          JWT_REFRESH_SECRET: 'r',
          ADMIN_EMAILS: admins,
          CONTENT_MANAGER_EMAILS: managers,
        };
        return map[k];
      });
    };

    // Первый вход через провайдера: привязки и аккаунта с таким адресом нет.
    const register = async (emailVerified = true) => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-new',
        email: user.email,
        emailVerified,
      });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(user);
      prisma.role.findUnique.mockResolvedValue({ id: `r-${RoleName.user}`, name: RoleName.user });
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });
      return service.socialLogin({ provider: 'google', token: 'id-token' });
    };

    it('адрес из ADMIN_EMAILS: одно событие admin, актёр null, запись тем же tx', async () => {
      withEnv(` ${user.email.toUpperCase()} , other@example.com`, '');
      await register();

      expect(adminAudit.record).toHaveBeenCalledTimes(1);
      const [client, event] = adminAudit.record.mock.calls[0] as [unknown, unknown];
      expect(client).toBe(tx);
      expect(client).not.toBe(prisma);
      expect(event).toEqual({
        action: AdminAuditAction.ROLE_ASSIGNED,
        targetType: AdminAuditTargetType.USER,
        targetId: user.id,
        actorUserId: null,
        payload: { role: RoleName.admin, source: ENV_BOOTSTRAP_AUDIT_SOURCE },
      });
      expect(ENV_BOOTSTRAP_AUDIT_SOURCE).toBe('env_bootstrap');
    });

    it('адрес в обоих списках: по событию на admin и content_manager, у user события нет', async () => {
      withEnv(user.email, user.email);
      await register();

      const roles = adminAudit.record.mock.calls.map(
        (call: [unknown, { payload: { role: RoleName } }]) => call[1].payload.role,
      );
      expect(roles).toEqual([RoleName.admin, RoleName.content_manager]);
      expect(tx.userRole.createMany).toHaveBeenCalledTimes(3);
    });

    it('адрес вне списков: базовая роль вложена в create, событий нет', async () => {
      withEnv('other@example.com', 'someone@example.com');
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.user } }]);
      const res = await register();

      expect(res.user.roles).toEqual([RoleName.user]);
      expect(tx.userRole.createMany).not.toHaveBeenCalled();
      expect(prisma.userRole.upsert).not.toHaveBeenCalled();
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.user.create.mock.calls[0][0].data.roles).toEqual({
        create: { roleId: `r-${RoleName.user}` },
      });
      // `LEGACY-015`/`T67`: роль читается до вставки, иначе вложить её в `create` нечем.
      expect(prisma.role.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.user.create.mock.invocationCallOrder[0],
      );
      expect(adminAudit.record).not.toHaveBeenCalled();
    });

    // 🔴 LEGACY-443: провайдер вошёл, но адрес не доказал - список не работает.
    it('адрес из списка, но провайдер его не подтвердил: повышенной роли нет', async () => {
      withEnv(user.email, user.email);
      await register(false);

      expect(tx.userRole.createMany).not.toHaveBeenCalled();
      expect(adminAudit.record).not.toHaveBeenCalled();
      // Базовая роль при этом на месте - вложенной записью в сам `create`.
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.user.create.mock.calls[0][0].data.roles).toEqual({
        create: { roleId: `r-${RoleName.user}` },
      });
    });

    it('список сверяется без учёта регистра: подтверждённый адрес получает content_manager', async () => {
      withEnv('', ` ${user.email.toUpperCase()} `);
      await register();

      const roles = adminAudit.record.mock.calls.map(
        (call: [unknown, { payload: { role: RoleName } }]) => call[1].payload.role,
      );
      expect(roles).toEqual([RoleName.content_manager]);
      expect(tx.userRole.createMany).toHaveBeenCalledTimes(2);
    });

    // 🔴 LEGACY-443: список выдаёт роль только при создании, не при входе в готовый аккаунт.
    it('аккаунт с этим адресом уже есть: вход повышенной роли не выдаёт', async () => {
      withEnv(user.email, user.email);
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-old',
        email: user.email,
        emailVerified: true,
      });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

      await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(tx.userRole.createMany).not.toHaveBeenCalled();
      expect(adminAudit.record).not.toHaveBeenCalled();
    });

    // Сегодня недостижимо: пользователь создан этой же транзакцией, `count` всегда 1.
    // Стоит как сторож инварианта «событие = изменение состояния», если путь
    // когда-нибудь позовут для существующего пользователя.
    it('роль уже была (count 0): вставка ничего не изменила — события нет', async () => {
      withEnv(user.email, '');
      tx.userRole.createMany.mockResolvedValue({ count: 0 });
      await register();

      expect(tx.userRole.createMany).toHaveBeenCalledTimes(2);
      expect(adminAudit.record).not.toHaveBeenCalled();
    });

    it('роли пишутся одной транзакцией с явным бюджетом, а не корневым клиентом', async () => {
      withEnv(user.email, '');
      await register();

      const callbackCalls = prisma.$transaction.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'function',
      );
      // Две транзакции: создание пользователя с ролями и журналом, затем отметка входа
      // с привязкой провайдера (`T122`). Обе — с явным бюджетом, роли пишет первая.
      expect(callbackCalls).toHaveLength(2);
      for (const call of callbackCalls) {
        expect(call[1]).toEqual({ timeout: 10_000, maxWait: 5_000 });
      }
      expect(tx.userRole.createMany).toHaveBeenCalled();
      expect(prisma.userRole.upsert).not.toHaveBeenCalled();
    });

    /**
     * Дефект, найденный ревью этой же правки: роли и журнал шли своей транзакцией после
     * создания пользователя корневым клиентом. Отказ записи журнала откатывал и базовую
     * роль — аккаунт оставался без ролей вовсе, а повторная регистрация получала 409.
     * Создание пользователя обязано идти тем же `tx`, что и роли.
     */
    it('пользователь создаётся той же транзакцией, что роли и журнал; отказ журнала роняет вход', async () => {
      withEnv(user.email, '');
      adminAudit.record.mockRejectedValueOnce(new Error('audit write failed'));

      await expect(register()).rejects.toThrow('audit write failed');
      expect(tx.user.create).toHaveBeenCalledTimes(1);
      expect(tx.user.create.mock.calls[0][0]).toMatchObject({ select: ACCOUNT_USER_SELECT });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  it('login: Unauthorized for missing user', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.login({ email: 'x@x', password: 'p' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('login: Unauthorized for wrong password', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(false);
    await expect(service.login({ email: user.email, password: 'p' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('login: success returns tokens and updates lastLogin', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    jwt.signAsync = jest.fn().mockResolvedValueOnce('acc2').mockResolvedValueOnce('ref2');
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValueOnce({ ...user, lastLogin: now });

    const res = await service.login({ email: user.email, password: 'p' });
    expect(res.user.roles).toEqual(['user']); // should include roles now
    expect(res.accessToken).toBe('acc2');
    expect(res.refreshToken).toBe('ref2');
    expect(prisma.user.update).toHaveBeenCalled();
  });

  /** Отказ `update` по условию `where`: строки под условием нет (здесь — пользователь заблокирован). */
  const notFound = () =>
    new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
      code: 'P2025',
      clientVersion: 'test',
    });

  /** Секунды «сейчас» под поддельным временем спеки — `iat` выдаваемых токенов. */
  const nowSec = Math.floor(now.getTime() / 1000);

  it('login: сроки и секреты токенов — из конфига, в обоих токенах версия сессий', async () => {
    config.get.mockImplementation(
      (k: string) =>
        ({
          JWT_ACCESS_SECRET: 'a',
          JWT_REFRESH_SECRET: 'r',
          JWT_ACCESS_EXPIRES_IN: '2h',
          JWT_REFRESH_EXPIRES_IN: '30d',
        })[k as 'JWT_ACCESS_SECRET'],
    );
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValueOnce({ tokenVersion: 4 });
    jwt.signAsync = jest.fn().mockResolvedValueOnce('a3').mockResolvedValueOnce('r3');
    const res = await service.login({ email: user.email, password: 'p' });
    expect(res.accessToken).toBe('a3');
    expect(res.refreshToken).toBe('r3');
    // Срок жизни и секрет каждого токена — из конфига, а не умолчания: значения нарочно не 15m/7d.
    const payload = { sub: user.id, email: user.email, roles: ['user'], tv: 4, iat: nowSec };
    expect(jwt.signAsync).toHaveBeenCalledTimes(2);
    expect(jwt.signAsync).toHaveBeenNthCalledWith(1, payload, { secret: 'a', expiresIn: '2h' });
    expect(jwt.signAsync).toHaveBeenNthCalledWith(2, payload, { secret: 'r', expiresIn: '30d' });
  });

  it('signTokens: без JWT_*_EXPIRES_IN в окружении сроки по умолчанию 15m и 7d', async () => {
    config.get.mockImplementation(
      (k: string) =>
        ({ JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'r' })[k as 'JWT_ACCESS_SECRET'],
    );
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    prisma.userRole.findMany.mockResolvedValue([]);
    jwt.signAsync = jest.fn().mockResolvedValueOnce('a4').mockResolvedValueOnce('r4');
    await service.login({ email: user.email, password: 'p' });
    expect(jwt.signAsync).toHaveBeenCalledTimes(2);
    expect(jwt.signAsync).toHaveBeenNthCalledWith(1, expect.anything(), {
      secret: 'a',
      expiresIn: '15m',
    });
    expect(jwt.signAsync).toHaveBeenNthCalledWith(2, expect.anything(), {
      secret: 'r',
      expiresIn: '7d',
    });
  });

  it('login: заблокированный пользователь с верным паролем сессии не получает (LEGACY-452)', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ ...user, isActive: false });
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    await expect(service.login({ email: user.email, password: 'p' })).rejects.toThrow(
      'Account is disabled',
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('login: версия сессий — из отметки входа после сверки пароля, а не из чтения до неё', async () => {
    // Чтение по почте видит версию 1, за время argon2 админ сменил пароль — версия 2.
    prisma.user.findUnique.mockResolvedValueOnce({ ...user, tokenVersion: 1 });
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValueOnce({ tokenVersion: 2 });

    await service.login({ email: user.email, password: 'p' });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    // Условие записи — живая строка: заблокированной отметка не пишется вовсе.
    expect(prisma.user.update.mock.calls[0][0]).toEqual({
      where: { id: user.id, isActive: true },
      data: { lastLogin: now },
      select: { tokenVersion: true },
    });
    expect(jwt.signAsync).toHaveBeenCalledTimes(2);
    for (const [payload] of jwt.signAsync.mock.calls as [{ tv: number }][]) {
      expect(payload.tv).toBe(2);
    }
  });

  it('login: блокировка, пришедшая за время сверки пароля, — 401 без токенов', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockRejectedValueOnce(notFound());

    await expect(service.login({ email: user.email, password: 'p' })).rejects.toThrow(
      'Account is disabled',
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('login: роли читаются после версии сессий — токен не несёт ролей старше своей tv', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    prisma.userRole.findMany.mockResolvedValue([]);

    await service.login({ email: user.email, password: 'p' });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.userRole.findMany.mock.invocationCallOrder[0],
    );
  });

  it('login: чужой отказ базы на отметке входа не выдаётся за блокировку', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
    prisma.userRole.findMany.mockResolvedValue([]);
    const outage = new Error('connection reset');
    prisma.user.update.mockRejectedValueOnce(outage);

    await expect(service.login({ email: user.email, password: 'p' })).rejects.toBe(outage);
  });

  describe('refresh (LEGACY-451, LEGACY-452)', () => {
    /** Refresh, выданный при входе, истекает через сутки от «сейчас». */
    const refreshExp = nowSec + 24 * 3600;

    function liveRefresh(tv: number | undefined = 2) {
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: user.id,
        email: user.email,
        tv,
        exp: refreshExp,
      });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: user.id,
        isActive: true,
        tokenVersion: 2,
      });
      prisma.userRole.findMany.mockResolvedValue([]);
    }

    it('новая пара наследует exp исходного refresh, а не получает полный срок', async () => {
      liveRefresh();
      jwt.signAsync = jest.fn().mockResolvedValueOnce('a5').mockResolvedValueOnce('r5');
      // access на 15 минут умирает раньше refresh — переподписывать нечего.
      jwt.decode.mockReturnValueOnce({ exp: nowSec + 900 });

      const res = await service.refresh({ refreshToken: 'tok' });

      expect(res).toEqual({ accessToken: 'a5', refreshToken: 'r5' });
      const payload = { sub: user.id, email: user.email, roles: ['user'], tv: 2, iat: nowSec };
      expect(jwt.signAsync).toHaveBeenCalledTimes(2);
      expect(jwt.signAsync).toHaveBeenNthCalledWith(1, payload, { secret: 'a', expiresIn: '15m' });
      // Остаток срока в секундах: `iat + expiresIn` даёт ровно прежний `exp`.
      expect(jwt.signAsync).toHaveBeenNthCalledWith(2, payload, {
        secret: 'r',
        expiresIn: refreshExp - nowSec,
      });
    });

    it('срок access на refresh — из конфига, а не умолчание', async () => {
      config.get.mockImplementation(
        (k: string) =>
          ({
            JWT_ACCESS_SECRET: 'a',
            JWT_REFRESH_SECRET: 'r',
            JWT_ACCESS_EXPIRES_IN: '2h',
          })[k as 'JWT_ACCESS_SECRET'],
      );
      liveRefresh();
      jwt.decode.mockReturnValueOnce({ exp: nowSec + 7200 });

      await service.refresh({ refreshToken: 'tok' });

      expect(jwt.signAsync).toHaveBeenCalledTimes(2);
      expect(jwt.signAsync.mock.calls[0][1]).toEqual({ secret: 'a', expiresIn: '2h' });
    });

    it('access, переживший бы свой refresh, переподписывается до срока refresh', async () => {
      liveRefresh();
      jwt.signAsync = jest
        .fn()
        .mockResolvedValueOnce('a-long')
        .mockResolvedValueOnce('r6')
        .mockResolvedValueOnce('a-cut');
      jwt.decode.mockReturnValueOnce({ exp: refreshExp + 1 });

      const res = await service.refresh({ refreshToken: 'tok' });

      expect(res).toEqual({ accessToken: 'a-cut', refreshToken: 'r6' });
      expect(jwt.signAsync).toHaveBeenCalledTimes(3);
      expect(jwt.signAsync).toHaveBeenNthCalledWith(3, expect.objectContaining({ tv: 2 }), {
        secret: 'a',
        expiresIn: refreshExp - nowSec,
      });
    });

    it('версия токена не совпала с текущей — 401, новой пары нет', async () => {
      liveRefresh(1);
      await expect(service.refresh({ refreshToken: 'tok' })).rejects.toThrow(
        'Session is no longer valid',
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('токен без tv (выдан до T122) считается версией 0', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email, exp: refreshExp });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: user.id,
        isActive: true,
        tokenVersion: 0,
      });
      prisma.userRole.findMany.mockResolvedValue([]);
      jwt.decode.mockReturnValueOnce({ exp: nowSec + 900 });
      await expect(service.refresh({ refreshToken: 'tok' })).resolves.toEqual({
        accessToken: 'acc',
        refreshToken: 'ref',
      });
    });

    it('заблокированный пользователь — 401', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: user.id,
        email: user.email,
        tv: 0,
        exp: refreshExp,
      });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: user.id,
        isActive: false,
        tokenVersion: 0,
      });
      await expect(service.refresh({ refreshToken: 'tok' })).rejects.toThrow('Account is disabled');
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('битый или просроченный токен — 401, а не 500 из библиотеки', async () => {
      // Библиотека бросает свою ошибку, а не исключение Nest: без перевода она уходит наружу 500.
      jwt.verifyAsync.mockRejectedValueOnce(new TokenExpiredError('jwt expired', new Date(0)));
      await expect(service.refresh({ refreshToken: 'bad' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('сбой не проверки токена, а чего-то другого — пробрасывается как есть, не 401', async () => {
      const outage = new Error('boom');
      jwt.verifyAsync.mockRejectedValueOnce(outage);
      await expect(service.refresh({ refreshToken: 'tok' })).rejects.toBe(outage);
    });

    it('нет секрета refresh — ошибка конфигурации, а не 401 «битый токен»', async () => {
      config.get.mockImplementation(
        (k: string) => ({ JWT_ACCESS_SECRET: 'a' })[k as 'JWT_ACCESS_SECRET'],
      );
      await expect(service.refresh({ refreshToken: 'tok' })).rejects.not.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });

    it('токен без tv, а версия в базе уже поднята — 401', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email, exp: refreshExp });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: user.id,
        isActive: true,
        tokenVersion: 1,
      });
      await expect(service.refresh({ refreshToken: 'tok' })).rejects.toThrow(
        'Session is no longer valid',
      );
    });

    it('refresh, истекающий в эту же секунду, даёт пару с нулевым остатком, а не ошибку', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        sub: user.id,
        email: user.email,
        tv: 2,
        exp: nowSec,
      });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: user.id,
        isActive: true,
        tokenVersion: 2,
      });
      prisma.userRole.findMany.mockResolvedValue([]);
      jwt.signAsync = jest
        .fn()
        .mockResolvedValueOnce('a7')
        .mockResolvedValueOnce('r7')
        .mockResolvedValueOnce('a7-cut');
      jwt.decode.mockReturnValueOnce({ exp: nowSec + 900 });

      await service.refresh({ refreshToken: 'tok' });

      expect(jwt.signAsync).toHaveBeenCalledTimes(3);
      expect(jwt.signAsync.mock.calls[1][1]).toEqual({ secret: 'r', expiresIn: 0 });
      expect(jwt.signAsync.mock.calls[2][1]).toEqual({ secret: 'a', expiresIn: 0 });
    });
  });

  describe('logout (LEGACY-451)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
      sessionStateCache.clear();
    });

    it('поднимает версию сессий условием на версию токена и сбрасывает кэш', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email, tv: 3, exp: 1 });
      prisma.user.updateMany.mockResolvedValueOnce({ count: 1 });
      const invalidate = jest.spyOn(sessionStateCache, 'invalidate');

      await expect(service.logout({ refreshToken: 'tok' })).resolves.toEqual({ success: true });

      expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: user.id, tokenVersion: 3 },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledWith(user.id);
    });

    it('уже погашенный токен: 200, версия повторно не растёт', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email, exp: 1 });
      prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
      const invalidate = jest.spyOn(sessionStateCache, 'invalidate');

      await expect(service.logout({ refreshToken: 'tok' })).resolves.toEqual({ success: true });

      // Без `tv` — версия 0, как и на refresh.
      expect(prisma.user.updateMany.mock.calls[0][0].where).toEqual({
        id: user.id,
        tokenVersion: 0,
      });
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('битый токен — 401, база не трогается', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new JsonWebTokenError('invalid signature'));
      await expect(service.logout({ refreshToken: 'bad' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('socialLogin (CR auth-social)', () => {
    const adminUser: User = { ...user, id: 'u-admin', email: 'admin@bibliaris.com' };

    function existingAdmin() {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.userRole.findMany.mockResolvedValue([
        { role: { name: RoleName.user } },
        { role: { name: RoleName.admin } },
        { role: { name: RoleName.content_manager } },
      ]);
      prisma.user.update.mockResolvedValue({ ...adminUser, lastLogin: now });
    }

    // Landing 2. The point of the whole change: the identity must come from the
    // verified provider answer. The body can no longer carry an e-mail at all
    // (the DTO rejects it), so what is pinned here is that the *lookup* uses the
    // provider's answer rather than anything else the request might imply.
    it('landing 2: identity comes from the verified token', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: 'real@example.com',
        emailVerified: true,
        name: 'Real',
      });
      prisma.user.findUnique.mockResolvedValue({ ...user, email: 'real@example.com' });
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.user } }]);
      prisma.user.update.mockResolvedValue({ ...user, email: 'real@example.com', lastLogin: now });

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(social.verify).toHaveBeenCalledWith('google', 'id-token');
      // L-005: без счёта вызовов `toHaveBeenCalledWith` означает «был ли когда-нибудь
      // такой вызов», и второй, сужающий вызов рядом утверждение бы не покрасил.
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'real@example.com' } }),
      );
      expect(res.user.email).toBe('real@example.com');
    });

    it('landing 2f: the same holds for facebook — a new account is created for a new identity', async () => {
      social.verify.mockResolvedValue({
        provider: 'facebook',
        providerUserId: 'fb-1',
        email: 'fbreal@example.com',
        emailVerified: false,
      });
      // Ни привязки, ни аккаунта с таким адресом: присваивать нечего.
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ ...user, email: 'fbreal@example.com' });
      prisma.role.findUnique.mockResolvedValue({ id: 1, name: RoleName.user });
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.user } }]);
      prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

      await service.socialLogin({ provider: 'facebook', token: 'fb-access-token' });

      expect(social.verify).toHaveBeenCalledWith('facebook', 'fb-access-token');
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'fbreal@example.com' } }),
      );
      expect(prisma.userIdentity.upsert).toHaveBeenCalled();
    });

    // Посадка миграции идентичности (NEXT-SESSION §5). Обязана краснеть на коде,
    // где пользователь искался по адресу почты: там этот вход выдавал сессию
    // владельцу парольного аккаунта, минуя пароль.
    it('аккаунт найден по почте, но заблокирован: ни привязки, ни сессии (LEGACY-452)', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-new-link',
        email: user.email,
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValueOnce({ ...user, isActive: false });

      await expect(service.socialLogin({ provider: 'google', token: 'id-token' })).rejects.toThrow(
        'Account is disabled',
      );
      expect(prisma.userIdentity.upsert).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('refuses to attach a weakly-proven provider to an existing account', async () => {
      social.verify.mockResolvedValue({
        provider: 'facebook',
        providerUserId: 'fb-squatter',
        email: 'password-owner@example.com',
        emailVerified: false,
      });
      prisma.user.findUnique.mockResolvedValue({ ...user, email: 'password-owner@example.com' });

      await expect(
        service.socialLogin({ provider: 'facebook', token: 'fb-access-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(prisma.userIdentity.upsert).not.toHaveBeenCalled();
    });

    // Обратная сторона той же границы: подтверждённый адрес привязку разрешает,
    // иначе прошлые входы через Google завели бы себе вторые аккаунты.
    it('links a verified provider to the existing account of the same address', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-new',
        email: 'user@example.com',
        emailVerified: true,
      });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.user } }]);
      prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(res.user.id).toBe(user.id);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.userIdentity.upsert).toHaveBeenCalled();
    });

    // Личность, а не адрес: при найденной привязке адрес провайдера вообще не
    // участвует в поиске пользователя.
    it('uses the stored link and never looks the user up by e-mail', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: 'renamed@example.com',
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.user } }]);
      prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(res.user.email).toBe(user.email);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: user.id } }),
      );
      // ⚠️ `objectContaining` здесь обязателен и в отрицании: с точным литералом это
      // утверждение проходило бы всегда — у вызова появился ещё и `select`, и
      // несовпадение аргумента целиком делало бы проверку «по почте не искали»
      // зелёной даже при возврате поиска по почте.
      expect(prisma.user.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'renamed@example.com' } }),
      );
    });

    it('заблокированный пользователь: ни сессии, ни привязки провайдера (LEGACY-452)', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: user.email,
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.user.findUnique.mockResolvedValue({ ...user, isActive: false });

      await expect(service.socialLogin({ provider: 'google', token: 'id-token' })).rejects.toThrow(
        'Account is disabled',
      );
      expect(prisma.userIdentity.upsert).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('версия сессий в токенах берётся из отметки входа', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: user.email,
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValue({ tokenVersion: 7 });

      await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.id, isActive: true },
        data: { lastLogin: now },
        select: { tokenVersion: true },
      });
      expect(jwt.signAsync).toHaveBeenCalledTimes(2);
      for (const [payload] of jwt.signAsync.mock.calls as [{ tv: number }][]) {
        expect(payload.tv).toBe(7);
      }
    });

    it('отметка входа раньше привязки провайдера и ролей', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: user.email,
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([]);

      await service.socialLogin({ provider: 'google', token: 'id-token' });

      const mark = prisma.user.update.mock.invocationCallOrder[0];
      expect(mark).toBeLessThan(prisma.userIdentity.upsert.mock.invocationCallOrder[0]);
      expect(mark).toBeLessThan(prisma.userRole.findMany.mock.invocationCallOrder[0]);
    });

    it('отметка входа и привязка провайдера пишутся одной транзакцией, а не корневым клиентом', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: user.email,
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([]);
      const txUpdate = jest.fn().mockResolvedValue({ tokenVersion: 5 });
      const txUpsert = jest.fn().mockResolvedValue({});
      // Массив — служебная транзакция базовых ролей (`ensureCoreRoles`), колбэк — вход.
      prisma.$transaction.mockImplementation((arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (client: unknown) => Promise<unknown>)({
              user: { update: txUpdate },
              userIdentity: { upsert: txUpsert },
            })
          : Promise.resolve(arg),
      );

      await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(txUpsert).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.userIdentity.upsert).not.toHaveBeenCalled();
      expect(txUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        txUpsert.mock.invocationCallOrder[0],
      );
    });

    it('блокировка между проверкой и отметкой входа: 401, токенов нет', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: user.email,
        emailVerified: true,
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockRejectedValueOnce(notFound());

      await expect(service.socialLogin({ provider: 'google', token: 'id-token' })).rejects.toThrow(
        'Account is disabled',
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
      // Привязка заблокированному не пишется: отметка входа отказала раньше неё.
      expect(prisma.userIdentity.upsert).not.toHaveBeenCalled();
    });

    // Landing 1. A rejected token must not produce a session of any kind.
    it('landing 1: a rejected token yields no session', async () => {
      social.verify.mockRejectedValue(new UnauthorizedException('bad token'));

      await expect(
        service.socialLogin({ provider: 'google', token: 'garbage' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    // Landing 3. The request that used to return an admin session: an admin
    // e-mail, no proof. There is no longer a code path that answers it — the
    // verifier is consulted first and has nothing to work with.
    it('landing 3: an admin e-mail without a token yields no session', async () => {
      existingAdmin();
      social.verify.mockRejectedValue(new UnauthorizedException('bad token'));

      await expect(
        service.socialLogin({ provider: 'google', token: 'not-a-real-token' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('a verified admin keeps the roles stored in the database', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-admin',
        email: 'admin@bibliaris.com',
        emailVerified: true,
      });
      existingAdmin();

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(res.user.roles).toEqual(
        expect.arrayContaining([RoleName.user, RoleName.admin, RoleName.content_manager]),
      );
    });

    it('первый вход через провайдера без роли `user` в базе: пользователь создаётся без ролей', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-new',
        email: 'newcomer@example.com',
        emailVerified: true,
      });
      const created = { ...user, id: 'u-new', email: 'newcomer@example.com' };
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(created);
      prisma.role.findUnique.mockResolvedValue(null);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValue({ ...created, lastLogin: now });

      await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.user.create.mock.calls[0][0].data.roles).toBeUndefined();
      expect(prisma.userRole.upsert).not.toHaveBeenCalled();
    });
  });

  /**
   * 🔴 Посадка `LEGACY-190`. Стережёт не пять названных записью мест, а **файл целиком**:
   * ни одно обращение к `this.prisma.user.*` не смеет читать запись без `select`, и
   * `passwordHash: true` во всём файле стоит ровно один раз — в `login`.
   *
   * Почему инвариант, а не перечисление вызовов: до правки все одиннадцать чтений шли без
   * `select`, argon2-хеш лежал в объекте, который дальше уходил в `publicUser`, и наружу
   * не попадал только потому, что `publicUser` перечисляет поля руками. От `return { ...user,
   * roles }` не защищал ни один автоматический механизм — запись прямо называет это ценой
   * одной невнимательной правки. Список из пяти имён воспроизвёл бы ту же дисциплинарную
   * защиту: шестое чтение, добавленное завтра, тест бы не заметил.
   *
   * ⚠️ Особый случай — `user.update` в `issueSocialSession` (ветка «провайдер дополнил имя
   * или аватар»): его результат присваивается **обратно** в `user`. Читай он без `select` —
   * хеш вернулся бы в уже очищенный объект, а спека на аргументы `findUnique` осталась бы
   * зелёной.
   */
  describe('LEGACY-190: пользователь читается только белым списком', () => {
    /**
     * Аргументы всех обращений к модели `User` — чтений и записей одинаково.
     *
     * Метод перечисляется не списком, а обходом самого стаба: новый делегат, добавленный
     * в мок ради нового метода сервиса, попадает сюда сам. Перечисление трёх имён молча
     * пропустило бы `findFirst` или `upsert`.
     */
    function userCalls(): UserCallArgs[] {
      return Object.values(prisma.user)
        .filter((fn) => typeof fn?.mock?.calls !== 'undefined')
        .flatMap((fn) => fn.mock.calls as unknown[][])
        .map((call) => call[0] as UserCallArgs);
    }

    function expectEverySelect(expectedCalls: number): void {
      const calls = userCalls();
      expect(calls).toHaveLength(expectedCalls);
      for (const args of calls) {
        expect(args).toHaveProperty('select');
        expect(Object.keys(args.select ?? {}).length).toBeGreaterThan(0);
      }
    }

    /** Сколько обращений просят argon2-хеш. Законное число — ноль везде, кроме `login`. */
    function passwordHashReads(): number {
      return userCalls().filter((args) => args?.select?.passwordHash === true).length;
    }

    it('register: проверка занятости почты берёт только id, создание — белый список', async () => {
      (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce(user);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValueOnce({ id: user.id });

      await service.register({ email: user.email, password: 'p', name: 'n' });

      // findUnique(занятость) + create + update(lastLogin)
      expectEverySelect(3);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual({ id: true });
      expect(prisma.user.create.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(prisma.user.update.mock.calls[0][0].select).toEqual({ tokenVersion: true });
      expect(passwordHashReads()).toBe(0);
    });

    it('login: хеш просит ровно одно обращение, и это чтение по почте', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(user);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValueOnce({ tokenVersion: 0 });

      const res = await service.login({ email: user.email, password: 'p' });

      expectEverySelect(2);
      expect(passwordHashReads()).toBe(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      const loginSelect = prisma.user.findUnique.mock.calls[0][0].select;
      expect(loginSelect.passwordHash).toBe(true);
      // Белый список ответа при этом остаётся целым: хеш добавлен к нему, а не вместо него.
      expect(loginSelect).toEqual({
        ...ACCOUNT_USER_SELECT,
        passwordHash: true,
      });
      // Отметка входа хеша не просит.
      expect(prisma.user.update.mock.calls[0][0].select).toEqual({ tokenVersion: true });
      // И наружу он не уходит.
      expect(res.user).not.toHaveProperty('passwordHash');
    });

    it('refresh: чтение по идентификатору из токена берёт только состояние сессии, без хеша', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email, exp: 2e9 });
      prisma.user.findUnique.mockResolvedValueOnce(user);
      prisma.userRole.findMany.mockResolvedValue([]);
      jwt.decode.mockReturnValueOnce({ exp: 0 });

      await service.refresh({ refreshToken: 'tok' });

      expectEverySelect(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual({
        id: true,
        isActive: true,
        tokenVersion: true,
      });
      expect(passwordHashReads()).toBe(0);
    });

    it('вход через провайдера по сохранённой привязке: чтение и обе записи без хеша', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-1',
        email: user.email,
        emailVerified: true,
        name: 'Provider Name',
        avatarUrl: 'https://example.test/a.png',
      });
      prisma.userIdentity.findUnique.mockResolvedValue({ userId: user.id });
      prisma.userIdentity.upsert.mockResolvedValue({});
      // Имени и аватара нет — значит сработает ветка дополнения профиля, тот самый update,
      // чей результат возвращается обратно в `user`.
      prisma.user.findUnique.mockResolvedValueOnce({ ...user, name: null, avatarUrl: null });
      // Отметка входа идёт раньше привязки и дополнения профиля (`markSignIn`).
      prisma.user.update
        .mockResolvedValueOnce({ tokenVersion: 0 })
        .mockResolvedValueOnce({ ...user, name: 'Provider Name' });
      prisma.userRole.findMany.mockResolvedValue([]);

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      // findUnique(по привязке) + update(lastLogin) + update(профиль)
      expectEverySelect(3);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
      expect(prisma.user.update.mock.calls[0][0].select).toEqual({ tokenVersion: true });
      // 🔴 Дополнение профиля возвращает запись в ту же переменную — здесь белый список
      // обязателен, иначе хеш приезжает обратно в очищенный объект.
      expect(prisma.user.update.mock.calls[1][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(passwordHashReads()).toBe(0);
      expect(res.user).not.toHaveProperty('passwordHash');
    });

    it('первый вход через провайдера: чтение по почте и создание аккаунта без хеша', async () => {
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-new',
        email: 'new@example.com',
        emailVerified: true,
        name: 'New',
      });
      prisma.userIdentity.findUnique.mockResolvedValue(null);
      prisma.userIdentity.upsert.mockResolvedValue({});
      prisma.user.findUnique.mockResolvedValueOnce(null); // такой почты ещё нет
      prisma.user.create.mockResolvedValueOnce({ ...user, id: 'u-new', email: 'new@example.com' });
      prisma.role.findUnique.mockResolvedValue({ id: 'r-user', name: 'user' });
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValueOnce({ id: 'u-new' });

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      // findUnique(по почте) + create + update(lastLogin)
      expectEverySelect(3);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.user.create.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(passwordHashReads()).toBe(0);
      expect(res.user).not.toHaveProperty('passwordHash');
    });

    /**
     * 🔴 Настоящий инвариант на файл, а не на пять прогнанных сценариев.
     *
     * Пять сценарных тестов выше проверяют аргументы **вызовов**, то есть только те
     * обращения, которые эти сценарии совершают. Сегодня так покрыты все одиннадцать, но завтрашний
     * `changePassword()` с чтением без `select` не вызовет ни один из них: прогон остался бы
     * зелёным, а комментарий в сервисе продолжал бы обещать, что чтений без белого списка
     * в файле не осталось. Ровно эту дыру запись `LEGACY-190` и называет ценой одной
     * невнимательной правки, поэтому сторож читает исходник.
     */
    describe('инвариант по исходнику сервиса', () => {
      /**
       * 🔴 Разбор идёт по дереву TypeScript, а не по тексту, и это решение арбитра
       * от 04.09.2026 (`decisions-log.md`, `C7 | LEGACY-190`), а не вкусовщина.
       *
       * Две предыдущие редакции сторожа читали исходник регулярками, и ревью пробило обе:
       * комментарий `// select:` рядом с вызовом принимался за настоящий отбор полей;
       * вызов, перенесённый форматированием на другую строку, переставал находиться вовсе;
       * вложенный `select` внутри `include` выдавал чтение всей записи за чтение белым
       * списком; чтения через `tx.user.*` внутри транзакции не были видны; скобка в
       * строковом литерале уводила разбор аргументов в соседний вызов. Пять разных
       * проявлений одного дефекта — проверки по подстроке, которая пропускает мутацию
       * (`L-008`). У дерева этих понятий нет вовсе, поэтому чинится класс, а не случаи.
       */
      const SOURCE = readFileSync(join(__dirname, 'auth.service.ts'), 'utf8');
      const AST = ts.createSourceFile('auth.service.ts', SOURCE, ts.ScriptTarget.Latest, true);

      /**
       * Методы клиента Prisma, у которых `select` вообще существует.
       *
       * ⚠️ Список белый, а не «всё, кроме массовых операций». Признак — наличие поля
       * `select` в типах, а не слово «many» в имени: у `deleteMany` и `updateMany` его нет
       * (требование к ним было бы неисполнимо — дописать `select` не даст `tsc`, а убрать
       * вызов нельзя, и сторож краснел бы на верной правке), но у `createManyAndReturn`
       * и `updateManyAndReturn` есть, и без него они возвращают все скаляры вместе с хешем.
       * Чёрный список снимал бы инвариант сам собой: метод, забытый в нём, молча выпадает
       * из-под охраны — поэтому забытый здесь метод, наоборот, остаётся под ней виден
       * через сверку числа обращений ниже.
       */
      const READING_METHODS = new Set([
        'findUnique',
        'findUniqueOrThrow',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'create',
        'createManyAndReturn',
        'update',
        'updateManyAndReturn',
        'upsert',
        'delete',
      ]);

      type UserCall = { method: string; argument: ts.ObjectLiteralExpression | null };

      /**
       * Все обращения к модели `User` — и через `this.prisma`, и через клиент транзакции.
       *
       * Имя объекта перед `.user` не проверяется: `tx.user.findUnique` внутри
       * `$transaction` — то же чтение той же таблицы, и мимо сторожа оно проходить
       * не должно (`books/CLAUDE.md`: внутри транзакции обращаться только через `tx`).
       */
      function userCallsInSource(): UserCall[] {
        const found: UserCall[] = [];

        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const methodAccess = node.expression;
            const owner = methodAccess.expression;
            if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'user') {
              const first = node.arguments[0];
              found.push({
                method: methodAccess.name.text,
                argument: first && ts.isObjectLiteralExpression(first) ? first : null,
              });
            }
          }
          ts.forEachChild(node, visit);
        };

        visit(AST);
        return found;
      }

      /** Свойство верхнего уровня аргумента — вложенные в `include` не считаются. */
      function topLevelProperty(
        literal: ts.ObjectLiteralExpression | null,
        name: string,
      ): ts.ObjectLiteralElementLike | undefined {
        return literal?.properties.find(
          (property) => property.name !== undefined && property.name.getText() === name,
        );
      }

      it('разбор видит все обращения к модели пользователя', () => {
        // Страховка от тихой поломки самого сторожа: обход дерева обязан найти столько же
        // обращений, сколько их видно в тексте. Разойдутся — значит разбор перестал
        // узнавать какую-то форму вызова, и его молчание означало бы «не смотрел»,
        // а не «чисто».
        //
        // ⚠️ Сверяется число, а не список имён: и новый метод с честным `select`,
        // и перенос записи внутрь `$transaction` (`this.prisma.user.create` →
        // `tx.user.create`) — правки верные, сторож обязан их пережить (`L-031`).
        //
        // 🔴 Комментарии срезает общий `stripComments`, а не своя копия рядом (`LEGACY-290`):
        // 2 реализации (`grep -rn "const stripComments" books/src books/test books/scripts`) —
        // общая здесь и последняя рукописная в `src/devops/deploy-trigger.spec.ts`. Копии
        // расходятся на краевых входах: общий срезает `//` только с начала строки — ради
        // адреса вида `https://…` внутри строкового литерала; своя редакция этого не
        // умела, и однострочный JSDoc со ссылкой ронял счёт, краснея на верной правке.
        //
        // ⚠️ Общее слепое пятно у обеих половин: обращение через промежуточную
        // переменную (`const users = this.prisma.user; users.findFirst(…)`) не видит
        // ни обход дерева, ни этот счёт, поэтому расхождения там не возникнет.
        // Инвариант держится на том, что в файле так не пишут, — не на разборе.
        const mentions = stripComments(SOURCE).match(/\.\s*user\s*\.\s*\w+\s*\(/g);
        expect(userCallsInSource()).toHaveLength(mentions?.length ?? 0);
      });

      it('ни одно чтение модели пользователя не идёт без select', () => {
        const reading = userCallsInSource().filter((call) => READING_METHODS.has(call.method));
        // Сегодня их десять (`T122`: три отметки входа сведены в одну `markSignIn`). Проверка
        // не в числе, а в том, что у каждого есть `select`: число здесь только показывает,
        // что выборка не опустела.
        expect(reading.length).toBeGreaterThanOrEqual(10);

        // ⚠️ Свойство берётся ВЕРХНЕГО уровня, и подмена `select` на `include` ловится
        // этим же утверждением, а не отдельным: `include` тянет все скаляры вместе
        // с хешем (отдельно названный в `books/CLAUDE.md` дефект проекта), но пара
        // `select` + `include` запрещена типами клиента, поэтому верхнеуровневый
        // `include` — это всегда отсутствие верхнеуровневого `select`. Отдельная
        // проверка на `include` здесь стояла и снята: покраснеть самостоятельно она
        // не могла никогда (`L-033`), а выглядела вторым рубежом.
        const unguarded = reading.filter((call) => !topLevelProperty(call.argument, 'select'));
        expect(unguarded.map((call) => call.method)).toEqual([]);
      });

      it('argon2-хеш просит ровно одно место во всём файле', () => {
        // Считается свойство `passwordHash: true` в любом объектном литерале файла —
        // и написанное прямо в аргументах, и спрятанное в константу с аннотацией типа
        // (`const RESET_SELECT: Prisma.UserSelect = {...}`), мимо которой прошёл бы
        // и разбор аргументов, и поиск по форме объявления.
        const asking: string[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isPropertyAssignment(node) && node.name.getText() === 'passwordHash') {
            if (node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
              asking.push(node.getText());
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(AST);

        expect(asking).toHaveLength(1);

        // И просит его вход: константа с хешем уходит ровно в одно чтение по адресу почты.
        const usingLoginSelect = userCallsInSource().filter((call) =>
          topLevelProperty(call.argument, 'select')?.getText().includes('LOGIN_USER_SELECT'),
        );
        expect(usingLoginSelect).toHaveLength(1);
        expect(usingLoginSelect[0].method).toBe('findUnique');
      });
    });
  });
});
