import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { Role } from '../decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { rolesCache } from '../roles/roles-cache';

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
  // Кэш ролей общий на процесс (`LEGACY-112`), поэтому между спеками он течёт.
  beforeEach(() => rolesCache.clear());

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

  // Читателей `UserRole` в коде два — гвард и `ModeratorRolesService.rolesOf`
  // (`LEGACY-111` свёл копии проверки, но не источник из окружения). Запрос
  // у них обязан совпадать, иначе `/uploads` и `/users/me` начнут отвечать не
  // то же, что админские маршруты; зеркальное утверждение стоит в
  // `moderator-roles.service.spec.ts`.
  it('читает роли тем же запросом, что и ModeratorRolesService', async () => {
    const { guard, prisma } = makeGuard({ requiredRoles: [Role.Admin], dbRoles: [] });
    await guard.canActivate(makeContext({ email: 'q@example.com', userId: 'query-shape' }));
    expect(prisma.userRole.findMany).toHaveBeenCalledWith({
      where: { userId: 'query-shape' },
      include: { role: true },
    });
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

  // CR auth-social: ADMIN_EMAILS is no longer a runtime source of a role.
  // It used to be compared against the e-mail claim carried by the request, so
  // whoever controlled that claim controlled the role. Roles live in the
  // database; the env list only bootstraps the first administrator through
  // register(), which writes to `UserRole`.
  it('never grants admin from the ADMIN_EMAILS list', async () => {
    const { guard, prisma } = makeGuard({
      requiredRoles: [Role.Admin],
      dbRoles: [],
      adminEmails: 'admin@example.com, another@ex.com',
    });
    const ctx = makeContext({ email: 'Admin@Example.com', userId: 'u3' });
    const res = await guard.canActivate(ctx);
    expect(res).toBe(false);
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);
  });

  it('never grants content_manager from the CONTENT_MANAGER_EMAILS list', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.ContentManager],
      dbRoles: [],
      managerEmails: 'mgr@example.com',
    });
    const res = await guard.canActivate(makeContext({ email: 'MGR@example.com', userId: 'u4' }));
    expect(res).toBe(false);
  });

  it('still grants admin when the role is in the database', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.Admin],
      dbRoles: [{ role: { name: Role.Admin } }],
      adminEmails: '',
    });
    const res = await guard.canActivate(makeContext({ email: 'admin@example.com', userId: 'u3b' }));
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

  // Phase 19: the lawyer role comes from the database only — no env escalation exists for it.
  it('grants a DB lawyer role on a lawyer-only endpoint', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.Lawyer],
      dbRoles: [{ role: { name: 'lawyer' } }],
    });
    const res = await guard.canActivate(makeContext({ email: 'l@example.com', userId: 'u7' }));
    expect(res).toBe(true);
  });

  it('denies a lawyer on an admin-only endpoint', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.Admin],
      dbRoles: [{ role: { name: 'lawyer' } }],
    });
    const res = await guard.canActivate(makeContext({ email: 'l@example.com', userId: 'u8' }));
    expect(res).toBe(false);
  });

  it('never grants the lawyer role through env email lists', async () => {
    const { guard } = makeGuard({
      requiredRoles: [Role.Lawyer],
      dbRoles: [],
      adminEmails: 'l@example.com',
      managerEmails: 'l@example.com',
    });
    const res = await guard.canActivate(makeContext({ email: 'l@example.com', userId: 'u9' }));
    expect(res).toBe(false);
  });

  // `LEGACY-112`: отзыв роли обязан действовать сразу, а не через TTL.
  describe('сброс кэша', () => {
    it('после invalidate доступ пропадает в том же тике, без ожидания TTL', async () => {
      const { guard, prisma } = makeGuard({
        requiredRoles: [Role.Admin],
        ttlMs: 60_000,
        dbRoles: [{ role: { name: Role.Admin } }],
      });
      const ctx = makeContext({ email: 'a@example.com', userId: 'revoked' });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);

      // Роль снята в базе; TTL ещё не истёк.
      prisma.userRole.findMany.mockResolvedValue([]);
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1);

      rolesCache.invalidate('revoked');

      expect(await guard.canActivate(ctx)).toBe(false);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2);
    });

    it('отзыв роли во время чтения из базы в кэш не попадает', async () => {
      const { guard, prisma } = makeGuard({
        requiredRoles: [Role.Admin],
        ttlMs: 60_000,
        dbRoles: [{ role: { name: Role.Admin } }],
      });
      const ctx = makeContext({ email: 'r@example.com', userId: 'racing' });

      // Роль снимают, пока запрос ждёт ответа базы: его результат устарел,
      // но записать он успевает уже после сброса.
      prisma.userRole.findMany.mockImplementationOnce(async () => {
        rolesCache.invalidate('racing');
        return Promise.resolve([{ role: { name: Role.Admin } }]);
      });

      expect(await guard.canActivate(ctx)).toBe(true);

      prisma.userRole.findMany.mockResolvedValue([]);
      // Устаревший ответ в кэш не лёг, поэтому следующий запрос идёт в базу
      // и видит отзыв. Возьми гвард отметку поколения после чтения — здесь
      // был бы попадание в кэш и `true` ещё на весь TTL.
      expect(await guard.canActivate(ctx)).toBe(false);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2);
    });

    it('сбрасывает только названного пользователя', async () => {
      const { guard, prisma } = makeGuard({
        requiredRoles: [Role.Admin],
        ttlMs: 60_000,
        dbRoles: [{ role: { name: Role.Admin } }],
      });
      const kept = makeContext({ email: 'k@example.com', userId: 'kept' });
      const dropped = makeContext({ email: 'd@example.com', userId: 'dropped' });

      expect(await guard.canActivate(kept)).toBe(true);
      expect(await guard.canActivate(dropped)).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2);

      rolesCache.invalidate('dropped');

      expect(await guard.canActivate(kept)).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2);
      expect(await guard.canActivate(dropped)).toBe(true);
      expect(prisma.userRole.findMany).toHaveBeenCalledTimes(3);
    });

    it('кэш общий для разных экземпляров гварда — их создаётся по одному на модуль', async () => {
      const first = makeGuard({
        requiredRoles: [Role.Admin],
        ttlMs: 60_000,
        dbRoles: [{ role: { name: Role.Admin } }],
      });
      const second = makeGuard({
        requiredRoles: [Role.Admin],
        ttlMs: 60_000,
        dbRoles: [{ role: { name: Role.Admin } }],
      });
      const ctx = makeContext({ email: 's@example.com', userId: 'shared' });

      expect(await first.guard.canActivate(ctx)).toBe(true);
      expect(await second.guard.canActivate(ctx)).toBe(true);
      // Второй экземпляр читает запись первого — в базу он не ходил.
      expect(second.prisma.userRole.findMany).not.toHaveBeenCalled();

      rolesCache.invalidate('shared');
      second.prisma.userRole.findMany.mockResolvedValue([]);

      expect(await second.guard.canActivate(ctx)).toBe(false);
      // Свежую запись второго экземпляра видит первый: в базу он ходил один раз.
      expect(await first.guard.canActivate(ctx)).toBe(false);
      expect(first.prisma.userRole.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
