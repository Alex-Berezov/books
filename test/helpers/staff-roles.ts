import type { INestApplication } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { rolesCache } from '../../src/common/roles/roles-cache';
import { PrismaService } from '../../src/prisma/prisma.service';
import { normalizeEmail } from '../../src/shared/validators/normalize-email.decorator';

/**
 * Выдаёт уже зарегистрированному пользователю роли сотрудника - записью в `UserRole`, как сид
 * (`prisma/seed.ts`, `addRoleForEmails`).
 *
 * До `LEGACY-443` e2e получали админа так: `ADMIN_EMAILS` в окружении и регистрация паролем.
 * Регистрация паролем роль по списку больше не даёт - пароль не доказывает владение адресом
 * (решение арбитра 08.10.2026, `decisions-log.md`). Боевой путь бутстрапа (первый вход через
 * провайдера с подтверждённым адресом) проверяет `env-role-escalation.e2e-spec.ts`; здесь только
 * подготовка данных. Регистрацию и вход хелпер не обходит: токен спека получает как раньше.
 *
 * Кэш ролей `RolesGuard` общий на процесс: запись в базу без его сброса не видна запросам
 * этого пользователя, уже прошедшим через гард.
 */
export async function grantStaffRoles(
  app: INestApplication,
  email: string,
  roles: readonly RoleName[] = [RoleName.admin],
): Promise<void> {
  const db = app.get(PrismaService);
  const user = await db.user.findUniqueOrThrow({
    where: { email: normalizeEmail(email) as string },
    select: { id: true },
  });
  for (const name of roles) {
    const role = await db.role.upsert({
      where: { name },
      update: {},
      create: { name },
      select: { id: true },
    });
    await db.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
  }
  rolesCache.invalidate(user.id);
}
