/* eslint-disable */
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SocialIdentityService } from './providers/social-identity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { RoleName, Language as PrismaLanguage, User } from '@prisma/client';
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_USER_SELECT } from '../../common/selects/account-user.select';
import { stripComments } from '../../common/testing/module-registration';

jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

describe('AuthService (unit)', () => {
  let service: AuthService;
  let prisma: any;
  let jwt: any;
  let config: any;
  let social: any;

  const now = new Date('2025-01-01T00:00:00Z');
  const user: User = {
    id: 'u1',
    email: 'user@example.com',
    passwordHash: 'hash',
    name: 'John',
    avatarUrl: null,
    languagePreference: PrismaLanguage.en,
    createdAt: now,
    lastLogin: null,
  } as any;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      role: { upsert: jest.fn(), findUnique: jest.fn() },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      userRole: { upsert: jest.fn(), findMany: jest.fn() },
      // Привязка личности провайдера. По умолчанию её нет — так выглядит первый
      // вход после миграции, когда `providerUserId` прошлых входов нигде не сохранён.
      userIdentity: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      $transaction: jest.fn(async (arr: any[]) => arr),
    };
    jwt = {
      signAsync: jest.fn().mockResolvedValueOnce('acc').mockResolvedValueOnce('ref'),
      verifyAsync: jest.fn(),
    } as Partial<JwtService> as any;
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
    } as Partial<ConfigService> as any;
    social = { verify: jest.fn() } as Partial<SocialIdentityService> as any;
    service = new AuthService(
      prisma as PrismaService,
      jwt as JwtService,
      config as ConfigService,
      social as SocialIdentityService,
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

  it('register: success, assigns roles and returns tokens', async () => {
    (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
    prisma.user.findUnique.mockResolvedValueOnce(null); // no existing
    prisma.user.create.mockResolvedValueOnce(user);
    prisma.role.findUnique.mockResolvedValue({ id: 'r-user', name: 'user' });
    prisma.userRole.upsert.mockResolvedValue({});
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

    const res = await service.register({ email: user.email, password: 'p', name: 'n' });
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.userRole.upsert).toHaveBeenCalled();
    expect(res.user.email).toBe(user.email);
    expect(res.user.roles).toEqual(['user']); // should include roles now
    expect(res.accessToken).toBe('acc');
    expect(res.refreshToken).toBe('ref');
  });

  /**
   * 🔴 Вторая половина контракта `LEGACY-170`. Роль времени выполнения по почте
   * больше не выдаётся нигде, но **бутстрап первого администратора этими же
   * списками жив** и обязан оставаться живым: без него на свежем стенде роль в
   * `UserRole` положить некому. Снимут блок `adminsList` в `register()` — этот
   * тест краснеет; e2e-сторож `test/env-role-escalation.e2e-spec.ts` его не
   * ловит, он проверяет ровно противоположный случай.
   */
  it('register: почта из ADMIN_EMAILS пишет роль admin в UserRole', async () => {
    config.get = jest.fn((k: string) => {
      const map: Record<string, string> = {
        JWT_ACCESS_SECRET: 'a',
        JWT_REFRESH_SECRET: 'r',
        ADMIN_EMAILS: user.email,
        CONTENT_MANAGER_EMAILS: '',
      };
      return map[k];
    });
    (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce(user);
    prisma.role.findUnique.mockImplementation((args: { where: { name: string } }) =>
      Promise.resolve({ id: `r-${args.where.name}`, name: args.where.name }),
    );
    prisma.userRole.upsert.mockResolvedValue({});
    prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.admin } }]);
    prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

    await service.register({ email: user.email, password: 'p', name: 'n' });

    const upsertedRoleIds = prisma.userRole.upsert.mock.calls.map(
      (call: [{ create: { roleId: string } }]) => call[0].create.roleId,
    );
    expect(upsertedRoleIds).toContain(`r-${RoleName.admin}`);
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

  it('refresh: verifies refresh token and returns new pair', async () => {
    jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email });
    prisma.user.findUnique.mockResolvedValueOnce(user);
    prisma.userRole.findMany.mockResolvedValue([]); // no DB roles
    jwt.signAsync = jest.fn().mockResolvedValueOnce('a3').mockResolvedValueOnce('r3');
    const res = await service.refresh({ refreshToken: 'tok' });
    expect(res.accessToken).toBe('a3');
    expect(res.refreshToken).toBe('r3');
  });

  it('refresh: invalid/expired token → Unauthorized', async () => {
    jwt.verifyAsync.mockRejectedValueOnce(new UnauthorizedException('invalid'));
    await expect(service.refresh({ refreshToken: 'bad' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('logout: returns success=true', () => {
    expect(service.logout()).toEqual({ success: true });
  });

  describe('socialLogin (CR auth-social)', () => {
    const adminUser: User = { ...user, id: 'u-admin', email: 'admin@bibliaris.com' } as any;

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

    it('does not grant roles from ADMIN_EMAILS when creating an account', async () => {
      config.get = jest.fn((k: string) => {
        const map: Record<string, string> = {
          JWT_ACCESS_SECRET: 'a',
          JWT_REFRESH_SECRET: 'r',
          ADMIN_EMAILS: 'newcomer@example.com',
        };
        return map[k];
      });
      social.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: 'g-new',
        email: 'newcomer@example.com',
        emailVerified: true,
      });
      const created = { ...user, id: 'u-new', email: 'newcomer@example.com' };
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(created);
      prisma.role.findUnique.mockResolvedValue({ id: 'r-user', name: RoleName.user });
      prisma.userRole.upsert.mockResolvedValue({});
      prisma.userRole.findMany.mockResolvedValue([{ role: { name: RoleName.user } }]);
      prisma.user.update.mockResolvedValue({ ...created, lastLogin: now });

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      expect(res.user.roles).toEqual([RoleName.user]);
      expect(prisma.userRole.upsert).toHaveBeenCalledTimes(1);
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
    function userCalls(): any[] {
      return Object.values(prisma.user)
        .filter((fn: any) => typeof fn?.mock?.calls !== 'undefined')
        .flatMap((fn: any) => fn.mock.calls)
        .map((call: any[]) => call[0]);
    }

    function expectEverySelect(expectedCalls: number): void {
      const calls = userCalls();
      expect(calls).toHaveLength(expectedCalls);
      for (const args of calls) {
        expect(args).toHaveProperty('select');
        expect(Object.keys(args.select as object).length).toBeGreaterThan(0);
      }
    }

    /** Сколько обращений просят argon2-хеш. Законное число — ноль везде, кроме `login`. */
    function passwordHashReads(): number {
      return userCalls().filter((args: any) => args?.select?.passwordHash === true).length;
    }

    it('register: проверка занятости почты берёт только id, создание — белый список', async () => {
      (argon2.hash as jest.Mock).mockResolvedValueOnce('hashed');
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce(user);
      prisma.role.findUnique.mockResolvedValue({ id: 'r-user', name: 'user' });
      prisma.userRole.upsert.mockResolvedValue({});
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValueOnce({ id: user.id });

      await service.register({ email: user.email, password: 'p', name: 'n' });

      // findUnique(занятость) + create + update(lastLogin)
      expectEverySelect(3);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual({ id: true });
      expect(prisma.user.create.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(prisma.user.update.mock.calls[0][0].select).toEqual({ id: true });
      expect(passwordHashReads()).toBe(0);
    });

    it('login: хеш просит ровно одно обращение, и это чтение по почте', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(user);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);
      prisma.userRole.findMany.mockResolvedValue([]);
      prisma.user.update.mockResolvedValueOnce({ id: user.id });

      const res = await service.login({ email: user.email, password: 'p' });

      expectEverySelect(2);
      expect(passwordHashReads()).toBe(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      const loginSelect = prisma.user.findUnique.mock.calls[0][0].select;
      expect(loginSelect.passwordHash).toBe(true);
      // Белый список ответа при этом остаётся целым: хеш добавлен к нему, а не вместо него.
      expect(loginSelect).toEqual({ ...ACCOUNT_USER_SELECT, passwordHash: true });
      // Отметка входа хеша не просит.
      expect(prisma.user.update.mock.calls[0][0].select).toEqual({ id: true });
      // И наружу он не уходит.
      expect(res.user).not.toHaveProperty('passwordHash');
    });

    it('refresh: чтение по идентификатору из токена идёт белым списком без хеша', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email });
      prisma.user.findUnique.mockResolvedValueOnce(user);
      prisma.userRole.findMany.mockResolvedValue([]);

      await service.refresh({ refreshToken: 'tok' });

      expectEverySelect(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
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
      prisma.user.update
        .mockResolvedValueOnce({ ...user, name: 'Provider Name' })
        .mockResolvedValueOnce({ id: user.id });
      prisma.userRole.findMany.mockResolvedValue([]);

      const res = await service.socialLogin({ provider: 'google', token: 'id-token' });

      // findUnique(по привязке) + update(профиль) + update(lastLogin)
      expectEverySelect(3);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
      // 🔴 Дополнение профиля возвращает запись в ту же переменную — здесь белый список
      // обязателен, иначе хеш приезжает обратно в очищенный объект.
      expect(prisma.user.update.mock.calls[0][0].select).toEqual(ACCOUNT_USER_SELECT);
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
      prisma.userRole.upsert.mockResolvedValue({});
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
        // Сегодня их одиннадцать. Проверка не в числе, а в том, что у каждого есть `select`:
        // число здесь только показывает, что выборка не опустела.
        expect(reading.length).toBeGreaterThanOrEqual(11);

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
