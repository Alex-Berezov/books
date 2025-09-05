import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { Role } from '../decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

type MockUser = { email: string; userId: string } | undefined;
type MockReq = { user?: { email: string; userId: string } };

function makeContext(user?: MockUser): ExecutionContext {
  const req: MockReq = { user };
  const handler = () => {};
  class Dummy {}
  return {
    switchToHttp: () => ({ getRequest: <T = unknown>() => req as unknown as T }),
    getHandler: () => handler,
    getClass: () => Dummy,
  } as unknown as ExecutionContext;
}

type PrismaMock = {
  userRole: { findMany: jest.Mock };
};

function makeGuard(params: {
  requiredRoles?: Role[] | undefined;
  ttlMs?: number;
  dbRoles?: Array<{ role: { name: string } }>;
  adminEmails?: string;
  managerEmails?: string;
}): { guard: RolesGuard; prisma: PrismaMock; configGet: jest.Mock; reflector: Reflector } {
  const {
    requiredRoles,
    ttlMs = 5000,
    dbRoles = [],
    adminEmails = '',
    managerEmails = '',
  } = params;

  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  } as unknown as Reflector;

  const prismaMock: PrismaMock = {
    userRole: { findMany: jest.fn().mockResolvedValue(dbRoles) },
  };
  const prisma = prismaMock as unknown as PrismaService;

  const configGet = jest.fn((key: string) => {
    if (key === 'ROLES_CACHE_TTL_MS') return String(ttlMs);
    if (key === 'ADMIN_EMAILS') return adminEmails;
    if (key === 'CONTENT_MANAGER_EMAILS') return managerEmails;
    return undefined as unknown;
  });
  const config = { get: configGet } as unknown as ConfigService;

  const guard = new RolesGuard(reflector, config, prisma);
  return { guard, prisma: prismaMock, configGet, reflector };
}

describe('RolesGuard', () => {
  it('returns true when no roles are required', async () => {
    const { guard, prisma } = makeGuard({ requiredRoles: undefined });
    const res = await guard.canActivate(makeContext({ email: 'a@a.com', userId: 'u1' }));
    expect(res).toBe(true);
    expect(prisma.userRole.findMany).not.toHaveBeenCalled();
  });

  it('returns false when user is missing', async () => {
    const { guard } = makeGuard({ requiredRoles: [Role.Admin] });
    const res = await guard.canActivate(makeContext(undefined));
    expect(res).toBe(false);
  });

  it('uses DB roles and caches them; cache hit avoids DB second time', async () => {
    const dbRoles = [{ role: { name: Role.Admin } }];
    const { guard, prisma } = makeGuard({ requiredRoles: [Role.Admin], ttlMs: 10000, dbRoles });
    const ctx = makeContext({ email: 'x@example.com', userId: 'u1' });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
    // second call should use cache
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when cache TTL is 0', async () => {
    const dbRoles = [{ role: { name: Role.ContentManager } }];
    const { guard, prisma } = makeGuard({
      requiredRoles: [Role.ContentManager],
      ttlMs: 0,
      dbRoles,
    });
    const ctx = makeContext({ email: 'm@example.com', userId: 'u2' });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2);
  });

  it('grants via env-based ADMIN_EMAILS fallback', async () => {
    const { guard, prisma } = makeGuard({
      requiredRoles: [Role.Admin],
      dbRoles: [],
      adminEmails: 'admin@example.com, another@ex.com',
    });
    const ctx = makeContext({ email: 'Admin@Example.com', userId: 'u3' });
    const res = await guard.canActivate(ctx);
    expect(res).toBe(true);
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
  });

  it('grants via env-based CONTENT_MANAGER_EMAILS fallback', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.ContentManager],
      dbRoles: [],
      managerEmails: 'mgr@example.com',
    });
    const res = await guard.canActivate(makeContext({ email: 'MGR@example.com', userId: 'u4' }));
    expect(res).toBe(true);
  });

  it('includes implicit user role baseline', async () => {
    const { guard } = makeGuard({ requiredRoles: [Role.User], dbRoles: [] });
    const res = await guard.canActivate(makeContext({ email: 'x@y.z', userId: 'u5' }));
    expect(res).toBe(true);
  });

  it('denies when required role is absent in DB and env lists', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.Admin],
      dbRoles: [],
      adminEmails: '',
      managerEmails: '',
    });
    const res = await guard.canActivate(makeContext({ email: 'user@example.com', userId: 'u6' }));
    expect(res).toBe(false);
  });
});
