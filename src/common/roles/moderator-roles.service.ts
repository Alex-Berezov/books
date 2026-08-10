import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * «Может ли этот пользователь видеть то, что скрыто от посетителя».
 *
 * ⚠️ Роль складывается из **двух** источников: связей `UserRole` в базе и
 * списков `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` в окружении. Забыть второй
 * — обычная ошибка: она даёт проверку, которая на проде отвечает «нет» тому,
 * кто на самом деле админ (`LEGACY-071`: вычистка `ADMIN_EMAILS` не снимала
 * эскалацию именно потому, что роли лежат ещё и в БД).
 *
 * Вынесено в общее место 10.08.2026: та же логика лежала копией в
 * `CommentsService.isModerator`, и `book-summary` стал бы третьей.
 */
@Injectable()
export class ModeratorRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async isModerator(actor?: { userId: string; email: string }): Promise<boolean> {
    const roles = await this.rolesOf(actor);
    return roles.has('admin') || roles.has('content_manager');
  }

  /** Строго `admin`: для метрик и прочего, где content_manager недостаточно. */
  async isAdmin(actor?: { userId: string; email: string }): Promise<boolean> {
    return (await this.rolesOf(actor)).has('admin');
  }

  private async rolesOf(actor?: { userId: string; email: string }): Promise<Set<string>> {
    if (!actor) return new Set();

    const dbRoles = await this.prisma.userRole.findMany({
      where: { userId: actor.userId },
      include: { role: true },
    });
    const roleSet = new Set(dbRoles.map((r) => r.role.name));

    const fromEnv = (key: string): string[] =>
      (this.config.get<string>(key) || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);

    const email = actor.email.toLowerCase();
    if (fromEnv('ADMIN_EMAILS').includes(email)) roleSet.add('admin');
    if (fromEnv('CONTENT_MANAGER_EMAILS').includes(email)) roleSet.add('content_manager');

    return roleSet;
  }
}
