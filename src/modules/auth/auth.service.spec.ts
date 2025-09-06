/* eslint-disable */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
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
      userRole: { upsert: jest.fn() },
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
    service = new AuthService(prisma as PrismaService, jwt as JwtService, config as ConfigService);
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
    prisma.user.update.mockResolvedValue({ ...user, lastLogin: now });

    const res = await service.register({ email: user.email, password: 'p', name: 'n' });
    expect(prisma.user.create).toHaveBeenCalled();
    expect(prisma.userRole.upsert).toHaveBeenCalled();
    expect(res.user.email).toBe(user.email);
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
    prisma.user.update.mockResolvedValueOnce({ ...user, lastLogin: now });

    const res = await service.login({ email: user.email, password: 'p' });
    expect(res.accessToken).toBe('acc2');
    expect(res.refreshToken).toBe('ref2');
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('refresh: verifies refresh token and returns new pair', async () => {
    jwt.verifyAsync.mockResolvedValueOnce({ sub: user.id, email: user.email });
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
});
