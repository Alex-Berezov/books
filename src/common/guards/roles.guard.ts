import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import type { UserRole as UserRoleModel, Role as RoleModel } from '@prisma/client';

@Injectable()
export class RolesGuard implements CanActivate {
  private cache = new Map<string, { roles: Set<Role>; exp: number }>();
  private readonly ttlMs: number;
  constructor(
    private reflector: Reflector,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    const raw = this.config.get<string>('ROLES_CACHE_TTL_MS');
    const parsed = raw ? Number(raw) : NaN;
    const value = Number.isFinite(parsed) ? parsed : 5000;
    this.ttlMs = value >= 0 ? value : 5000;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { email: string; userId: string };
    }>();
    const user = request.user;
    if (!user) return false;

    // cache first
    const now = Date.now();
    const cached = this.cache.get(user.userId);
    if (cached && cached.exp > now) {
      return requiredRoles.some((role) => cached.roles.has(role));
    }

    // 1) Roles from DB (fresh)
    const dbRoles: (UserRoleModel & { role: RoleModel })[] = await this.prisma.userRole.findMany({
      where: { userId: user.userId },
      include: { role: true },
    });
    const roleNamesFromDb = new Set<Role>(dbRoles.map((ur) => ur.role.name as Role));

    // 2) Fallback: env-based elevated roles
    const adminsList = (this.config.get<string>('ADMIN_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const managersList = (this.config.get<string>('CONTENT_MANAGER_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (adminsList.includes(user.email.toLowerCase())) roleNamesFromDb.add(Role.Admin);
    if (managersList.includes(user.email.toLowerCase())) roleNamesFromDb.add(Role.ContentManager);

    // 'user' role is implicit baseline
    roleNamesFromDb.add(Role.User);

    // store in cache
    this.cache.set(user.userId, { roles: roleNamesFromDb, exp: now + this.ttlMs });
    return requiredRoles.some((role) => roleNamesFromDb.has(role));
  }
}
