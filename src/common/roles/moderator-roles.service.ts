import { Injectable } from '@nestjs/common';
import type { RoleName } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * «Может ли этот пользователь видеть то, что скрыто от посетителя».
 *
 * 🔴 Источник роли ровно один — связи `UserRole` в базе, тот же, что читает
 * `RolesGuard`. Списки `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` роль времени
 * выполнения **не выдают** (`LEGACY-170`): пока они это делали, один и тот же
 * аккаунт был модератором для `isModerator` и получал 403 на маршруте с
 * `@Roles(Role.Admin)` — права разъезжались по двум источникам истины.
 * Возвращать сюда чтение окружения нельзя; первого администратора заводят
 * `register()` и `prisma/seed.ts`, и оба пишут в `UserRole`.
 *
 * Вынесено в общее место 10.08.2026: та же логика лежала копией в
 * `CommentsService.isModerator`, и `book-summary` стал бы третьей.
 */
@Injectable()
export class ModeratorRolesService {
  constructor(private readonly prisma: PrismaService) {}

  async isModerator(actor?: { userId: string; email: string }): Promise<boolean> {
    const roles = await this.rolesOf(actor);
    return roles.has('admin') || roles.has('content_manager');
  }

  /** Строго `admin`: для метрик и прочего, где content_manager недостаточно. */
  async isAdmin(actor?: { userId: string; email: string }): Promise<boolean> {
    return (await this.rolesOf(actor)).has('admin');
  }

  /**
   * Роли пользователя из базы, без неявной базовой `user`.
   *
   * ⚠️ Публичный метод — точка сведения (`LEGACY-111`), а не приглашение
   * считать роли по-своему. Звать его можно там, где нужен **полный** набор
   * ролей (выдача профиля), а не ответ «модератор ли это»: для второго есть
   * `isModerator` и `isAdmin`.
   *
   * `email` в аргументе остаётся ради общей формы актора у вызывающих; роль он
   * не решает и решать не должен — это claim из токена, а не учётная запись.
   */
  async rolesOf(actor?: { userId: string; email: string }): Promise<Set<RoleName>> {
    if (!actor) return new Set();

    const dbRoles = await this.prisma.userRole.findMany({
      where: { userId: actor.userId },
      include: { role: true },
    });

    return new Set(dbRoles.map((r) => r.role.name));
  }

  /**
   * Роли сразу для набора пользователей — одним запросом на всех.
   *
   * 🔴 Заведён вместо вызова `rolesOf` в цикле (`LEGACY-125`): админский список
   * при `limit=50` уходил в базу пятьдесят раз. Считать роли пакетно мимо этого
   * сервиса нельзя — он остаётся единственной точкой сведения (`LEGACY-111`),
   * и второй такой запрос разъедется с ним при первой же правке.
   *
   * В карте есть ключ на каждого запрошенного пользователя, в том числе пустое
   * множество для тех, у кого нет ни одной связи `UserRole`.
   */
  async rolesOfMany(userIds: string[]): Promise<Map<string, Set<RoleName>>> {
    const map = new Map<string, Set<RoleName>>();
    for (const id of userIds) map.set(id, new Set());
    if (userIds.length === 0) return map;

    const dbRoles = await this.prisma.userRole.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, role: { select: { name: true } } },
    });

    for (const r of dbRoles) {
      map.get(r.userId)?.add(r.role.name);
    }
    return map;
  }
}
