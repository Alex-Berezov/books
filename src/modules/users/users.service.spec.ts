/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { RoleName, Language as PrismaLanguage, User } from '@prisma/client';

describe('UsersService (unit)', () => {
  let service: UsersService;
  let prismaMock: any;
  let config: any;

  const baseUser: User = {
    id: 'u1',
    email: 'user@example.com',
    passwordHash: 'hash',
    name: 'John',
    avatarUrl: null,
    languagePreference: PrismaLanguage.en,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastLogin: null,
  } as any;

  beforeEach(() => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      userRole: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      role: {
        findUnique: jest.fn(),
      },
      comment: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      like: {
        deleteMany: jest.fn(),
      },
      bookshelf: { deleteMany: jest.fn() },
      readingProgress: { deleteMany: jest.fn() },
      viewStat: { updateMany: jest.fn() },
      mediaAsset: { updateMany: jest.fn() },
      $transaction: jest.fn((arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg(prismaMock);
      }),
    };

    config = {
      get: jest.fn((key: string) => {
        if (key === 'ADMIN_EMAILS') return '';
        if (key === 'CONTENT_MANAGER_EMAILS') return '';
        return undefined;
      }),
    };

    service = new UsersService(prismaMock as unknown as PrismaService, config as ConfigService);
  });

  it('me: throws NotFound if user missing', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.me('unknown')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('me: returns public user and baseline role user', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.userRole.findMany.mockResolvedValueOnce([]);
    const res = await service.me('u1');
    expect(res.email).toBe(baseUser.email);
    expect(res.roles).toContain('user');
  });

  it('me: ENV elevates to admin/content_manager', async () => {
    config.get.mockImplementation((key: string) => {
      if (key === 'ADMIN_EMAILS') return 'user@example.com';
      if (key === 'CONTENT_MANAGER_EMAILS') return 'other@example.com,user@example.com';
      return undefined as any;
    });
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.userRole.findMany.mockResolvedValueOnce([]);
    const res = await service.me('u1');
    expect(res.roles).toEqual(expect.arrayContaining(['user', 'admin', 'content_manager']));
  });

  it('updateMe: updates allowed fields and returns public user', async () => {
    const updated = { ...baseUser, name: 'Jane', avatarUrl: 'a.png' } as User;
    prismaMock.user.update.mockResolvedValueOnce(updated);
    const res = await service.updateMe('u1', { name: 'Jane', avatarUrl: 'a.png' });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { name: 'Jane', avatarUrl: 'a.png' },
    });
    expect(res.name).toBe('Jane');
    expect((res as any).passwordHash).toBeUndefined();
  });

  it('deleteById: NotFound when user missing initially', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.deleteById('u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteById: performs cascading cleanup and returns public user', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    // comments authored by user
    (prismaMock.comment.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }]);
    (prismaMock.like.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.comment.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.comment.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
    (prismaMock.bookshelf.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.readingProgress.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.viewStat.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.mediaAsset.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.userRole.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.user.delete as jest.Mock).mockResolvedValue(baseUser);

    const res = await service.deleteById('u1');
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.like.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prismaMock.comment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
    });
    expect(res.email).toBe(baseUser.email);
  });

  it('assignRole + revokeRole happy path', async () => {
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValue(baseUser);
    (prismaMock.role.findUnique as jest.Mock).mockResolvedValue({
      id: 'r1',
      name: 'admin' as RoleName,
    });
    const upsert = jest.fn().mockResolvedValue({});
    prismaMock.userRole.upsert = upsert;
    const res = await service.assignRole('u1', 'admin');
    expect(upsert).toHaveBeenCalled();
    expect(res).toEqual({ userId: 'u1', role: 'admin' });

    const del = jest.fn().mockResolvedValue({});
    prismaMock.userRole.delete = del;
    const revoked = await service.revokeRole('u1', 'admin');
    expect(del).toHaveBeenCalledWith({ where: { userId_roleId: { userId: 'u1', roleId: 'r1' } } });
    expect(revoked).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('revokeRole: cannot revoke base user role', async () => {
    await expect(service.revokeRole('u1', 'user')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('assignRole: user or role not found', async () => {
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.assignRole('missing', 'admin')).rejects.toBeInstanceOf(NotFoundException);

    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);
    (prismaMock.role.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.assignRole('u1', 'admin')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokeRole: user or role not found (and non-existing link delete throws handled by service path)', async () => {
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.revokeRole('missing', 'admin')).rejects.toBeInstanceOf(NotFoundException);

    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);
    (prismaMock.role.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.revokeRole('u1', 'admin')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list: pagination boundaries and staff=exclude filter', async () => {
    const uA = { ...baseUser, id: 'uA', email: 'admin@example.com' } as User;
    const uB = { ...baseUser, id: 'uB', email: 'plain@example.com' } as User;
    (prismaMock.user.count as jest.Mock).mockResolvedValue(2);
    (prismaMock.user.findMany as jest.Mock).mockResolvedValue([uA, uB]);
    (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

    const res = await service.list({ page: 1, limit: 1, staff: 'exclude' });
    expect(res.page).toBe(1);
    expect(res.limit).toBe(1);
    expect(Array.isArray(res.items)).toBe(true);
  });

  it('list: staff only includes users with DB roles or ENV emails; returns items with computed roles', async () => {
    config.get.mockImplementation((key: string) => {
      if (key === 'ADMIN_EMAILS') return 'admin@example.com';
      if (key === 'CONTENT_MANAGER_EMAILS') return '';
      return undefined as any;
    });
    const uA = { ...baseUser, id: 'uA', email: 'admin@example.com' } as User;
    const uB = { ...baseUser, id: 'uB', email: 'plain@example.com' } as User;
    (prismaMock.user.count as jest.Mock).mockResolvedValue(2);
    (prismaMock.user.findMany as jest.Mock).mockResolvedValue([uA, uB]);
    // computeRoles path → mock userRole.findMany empty so ENV elevates uA only
    (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

    const res = await service.list({ page: 1, limit: 10, staff: 'only' });
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(res.items.length).toBe(2);
    const adminItem = res.items.find((i) => i.email === 'admin@example.com')!;
    expect(adminItem.roles).toContain('admin');
  });
});
