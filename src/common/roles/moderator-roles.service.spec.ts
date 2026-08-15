import { ModeratorRolesService } from './moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Единственная точка, где считается роль сотрудника (`LEGACY-111`), и источник
 * у неё ровно один — связи `UserRole` (`LEGACY-170`). Набор входов полный по
 * построению: роли в базе есть, ролей нет, актора нет.
 *
 * ⚠️ Разбор `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` в репозитории остаётся, но
 * только там, где он **пишет** роль в базу: `AuthService.register` и
 * `prisma/seed.ts` заводят первого администратора. Роль времени выполнения по
 * почте больше не выдаётся нигде — блок «окружение роли не выдаёт» ниже и есть
 * сторож этого.
 */

type Params = {
  dbRoles?: Array<{ role: { name: string } }>;
};

const makeService = (
  params: Params = {},
): { service: ModeratorRolesService; findMany: jest.Mock } => {
  const { dbRoles = [] } = params;

  const findMany = jest.fn().mockResolvedValue(dbRoles);
  const prisma = { userRole: { findMany } } as unknown as PrismaService;

  return { service: new ModeratorRolesService(prisma), findMany };
};

const actor = { userId: 'u1', email: 'staff@example.com' };

describe('ModeratorRolesService', () => {
  describe('ролей нет', () => {
    it('без актора не ходит в базу и не даёт ролей', async () => {
      const { service, findMany } = makeService();
      await expect(service.rolesOf(undefined)).resolves.toEqual(new Set());
      await expect(service.isModerator(undefined)).resolves.toBe(false);
      await expect(service.isAdmin(undefined)).resolves.toBe(false);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('пустая база — не модератор', async () => {
      const { service } = makeService();
      await expect(service.rolesOf(actor)).resolves.toEqual(new Set());
      await expect(service.isModerator(actor)).resolves.toBe(false);
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });

    it('роль user из базы модератором не делает', async () => {
      const { service } = makeService({ dbRoles: [{ role: { name: 'user' } }] });
      await expect(service.isModerator(actor)).resolves.toBe(false);
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });

    // Роль есть в схеме и на ней держится юридический контур; модератором
    // контента юрист при этом не является, и загрузка аудио ему не открыта.
    it('роль lawyer из базы модератором не делает', async () => {
      const { service } = makeService({ dbRoles: [{ role: { name: 'lawyer' } }] });
      await expect(service.isModerator(actor)).resolves.toBe(false);
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });
  });

  describe('источник — база', () => {
    it('admin из базы даёт и isModerator, и isAdmin', async () => {
      const { service, findMany } = makeService({ dbRoles: [{ role: { name: 'admin' } }] });
      await expect(service.rolesOf(actor)).resolves.toEqual(new Set(['admin']));
      await expect(service.isModerator(actor)).resolves.toBe(true);
      await expect(service.isAdmin(actor)).resolves.toBe(true);
      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        include: { role: true },
      });
    });

    it('content_manager из базы даёт isModerator, но не isAdmin', async () => {
      const { service } = makeService({ dbRoles: [{ role: { name: 'content_manager' } }] });
      await expect(service.isModerator(actor)).resolves.toBe(true);
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });
  });

  /**
   * 🔴 Сторож `LEGACY-170`. Пока эти списки поднимали роль здесь, аккаунт был
   * модератором для `isModerator` и получал 403 на маршруте с `@Roles`: права
   * держались на двух источниках истины сразу. Возврат чтения окружения в
   * `rolesOf` роняет весь блок.
   */
  describe('окружение роли не выдаёт', () => {
    const saved = {
      admin: process.env.ADMIN_EMAILS,
      manager: process.env.CONTENT_MANAGER_EMAILS,
    };

    /** Присваивание `undefined` кладёт в `process.env` строку `"undefined"`. */
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    beforeEach(() => {
      process.env.ADMIN_EMAILS = 'staff@example.com';
      process.env.CONTENT_MANAGER_EMAILS = 'staff@example.com';
    });

    afterAll(() => {
      restore('ADMIN_EMAILS', saved.admin);
      restore('CONTENT_MANAGER_EMAILS', saved.manager);
    });

    it('почта в обоих списках без строки в UserRole прав не даёт', async () => {
      const { service } = makeService();
      await expect(service.rolesOf(actor)).resolves.toEqual(new Set());
      await expect(service.isModerator(actor)).resolves.toBe(false);
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });

    it('роль из базы окружением не дополняется', async () => {
      const { service } = makeService({ dbRoles: [{ role: { name: 'lawyer' } }] });
      await expect(service.rolesOf(actor)).resolves.toEqual(new Set(['lawyer']));
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });
  });

  it('базовую роль user сам не добавляет — это дело вызывающего', async () => {
    const { service } = makeService({ dbRoles: [{ role: { name: 'admin' } }] });
    await expect(service.rolesOf(actor)).resolves.not.toContain('user');
  });
});
