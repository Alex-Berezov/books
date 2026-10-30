import type { PrismaClient, RoleName } from '@prisma/client';

/**
 * Роль сотрудника по списку адресов из окружения (`ADMIN_EMAILS`, `CONTENT_MANAGER_EMAILS`), идемпотентно.
 *
 * Только аккаунту, чью почту назвала его привязка провайдера: адрес доказан провайдером, как в `createSocialUser`
 * (`LEGACY-443`). Аккаунт, заведённый паролем, адрес не доказывает - ручной запуск сида после чужой
 * регистрации адреса из списка отдал бы тому админа.
 */
export async function addRoleForEmails(
  prisma: PrismaClient,
  emailsCsv: string | undefined,
  roleName: RoleName,
): Promise<void> {
  const emails = (emailsCsv || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return;
  const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
  if (!role?.id) return;
  for (const email of emails) {
    const user = await prisma.user.findFirst({
      where: { email, identities: { some: { email } } },
      select: { id: true },
    });
    if (!user?.id) {
      // Адрес из списка без привязки провайдера с той же почтой - роль не выдаётся (LEGACY-443);
      // строка в выводе сида, иначе прежнее поведение (роль аккаунту с паролем) пропадало бы молча.
      console.log(`Seed: ${roleName} for ${email} skipped - no provider link with this e-mail`);
      continue;
    }
    // Одной вставкой с `skipDuplicates`, а не «прочитал - создал»: два прогона сида на одной базе
    // иначе роняли бы второй на `P2002` по `userId_roleId`.
    await prisma.userRole.createMany({
      data: [{ userId: user.id, roleId: role.id }],
      skipDuplicates: true,
    });
  }
}
