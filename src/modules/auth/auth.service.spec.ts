/* eslint-disable */
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SocialIdentityService } from './providers/social-identity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { RoleName, Language as PrismaLanguage, User } from '@prisma/client';

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
    prisma.userRole.findMany.mockResolvedValue([]); // no DB roles, will get from ENV
    prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

    const res = await service.register({ email: user.email, password: 'p', name: 'n' });
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.userRole.upsert).toHaveBeenCalled();
    expect(res.user.email).toBe(user.email);
    expect(res.user.roles).toEqual(['user']); // should include roles now
    expect(res.accessToken).toBe('acc');
    expect(res.refreshToken).toBe('ref');
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
    prisma.userRole.findMany.mockResolvedValue([]); // no DB roles, will get from ENV
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
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'real@example.com' } });
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
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'fbreal@example.com' },
      });
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
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: user.id } });
      expect(prisma.user.findUnique).not.toHaveBeenCalledWith({
        where: { email: 'renamed@example.com' },
      });
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
});
