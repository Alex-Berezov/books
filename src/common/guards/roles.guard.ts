import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: { email: string } }>();
    const user = request.user;
    if (!user) return false;

    // Simple policy: admin emails from env (comma-separated). Later replace with roles in DB.
    const adminsList = (this.config.get<string>('ADMIN_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const isAdmin = adminsList.includes(user.email.toLowerCase());

    // User role always present; admin adds elevated access
    const userRoles: Role[] = isAdmin ? [Role.User, Role.Admin] : [Role.User];
    return requiredRoles.some((role) => userRoles.includes(role));
  }
}
