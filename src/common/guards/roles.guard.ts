import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { rolesCache } from '../roles/roles-cache';
import type { UserRole as UserRoleModel, Role as RoleModel } from '@prisma/client';

@Injectable()
export class RolesGuard implements CanActivate {
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
    const cached = rolesCache.get(user.userId, now);
    if (cached) {
      return requiredRoles.some((role) => cached.has(role));
    }

    // Отметка берётся ДО чтения из базы: если между чтением и записью в кэш
    // роль отзовут, результат этого чтения уже устарел и в кэш не попадёт
    // (`LEGACY-112`). Строкой ниже её брать бессмысленно — гонка как раз в
    // промежутке.
    const readGeneration = rolesCache.beginRead();

    // Roles from DB (fresh) — the only source.
    //
    // `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` used to elevate here as a
    // fallback, comparing an env list against the e-mail claim carried by the
    // request. That made the token's e-mail, rather than the account, decide
    // the role. Bootstrapping the first administrator is register()'s job and
    // it writes to `UserRole`.
    const dbRoles: (UserRoleModel & { role: RoleModel })[] = await this.prisma.userRole.findMany({
      where: { userId: user.userId },
      include: { role: true },
    });
    const roleNamesFromDb = new Set<Role>(dbRoles.map((ur) => ur.role.name as Role));

    // 'user' role is implicit baseline
    roleNamesFromDb.add(Role.User);

    // store in cache
    rolesCache.set(user.userId, roleNamesFromDb, now + this.ttlMs, now, readGeneration);
    return requiredRoles.some((role) => roleNamesFromDb.has(role));
  }
}
