import { ConfigService } from '@nestjs/config';
import { ModeratorRolesService } from './moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Точка, где роль складывается из двух источников (`LEGACY-111`). Набор входов
 * полный по построению: только БД, только окружение, оба, ничего.
 *
 * ⚠️ Копии разбора тех же двух списков окружения в репозитории ещё остались,
 * и они решают не вопрос «какая роль», а другие задачи: `UsersService.list`
 * строит по ним фильтр Prisma (причём без `toLowerCase()`, то есть с почтой
 * в смешанном регистре расходится с этим сервисом), `AuthService.register`
 * поднимает первого администратора при регистрации. Под сведение они не
 * попали, и «копий не осталось» про репозиторий сказать нельзя.
 */

type Params = {
  dbRoles?: Array<{ role: { name: string } }>;
  adminEmails?: string;
  managerEmails?: string;
};

const makeService = (
  params: Params = {},
): { service: ModeratorRolesService; findMany: jest.Mock } => {
  const { dbRoles = [], adminEmails = '', managerEmails = '' } = params;

  const findMany = jest.fn().mockResolvedValue(dbRoles);
  const prisma = { userRole: { findMany } } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ADMIN_EMAILS') return adminEmails;
      if (key === 'CONTENT_MANAGER_EMAILS') return managerEmails;
      return undefined as unknown;
    }),
  } as unknown as ConfigService;

  return { service: new ModeratorRolesService(prisma, config), findMany };
};

const actor = { userId: 'u1', email: 'staff@example.com' };

describe('ModeratorRolesService', () => {
  describe('источник — ничего', () => {
    it('без актора не ходит в базу и не даёт ролей', async () => {
      const { service, findMany } = makeService();
      await expect(service.rolesOf(undefined)).resolves.toEqual(new Set());
      await expect(service.isModerator(undefined)).resolves.toBe(false);
      await expect(service.isAdmin(undefined)).resolves.toBe(false);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('пустая база и пустые списки — не модератор', async () => {
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

  describe('источник — только база', () => {
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

  describe('источник — только окружение', () => {
    it('почта в ADMIN_EMAILS поднимает до admin', async () => {
      const { service } = makeService({ adminEmails: 'staff@example.com' });
      await expect(service.rolesOf(actor)).resolves.toEqual(new Set(['admin']));
      await expect(service.isAdmin(actor)).resolves.toBe(true);
    });

    it('почта в CONTENT_MANAGER_EMAILS поднимает до content_manager', async () => {
      const { service } = makeService({ managerEmails: 'staff@example.com' });
      await expect(service.isModerator(actor)).resolves.toBe(true);
      await expect(service.isAdmin(actor)).resolves.toBe(false);
    });

    it('регистр и пробелы в списке значения не имеют', async () => {
      const { service } = makeService({ adminEmails: ' , OTHER@ex.com ,  Staff@Example.COM , ' });
      await expect(service.isAdmin({ userId: 'u1', email: 'STAFF@example.com' })).resolves.toBe(
        true,
      );
    });

    it('чужая почта из списка прав не даёт', async () => {
      const { service } = makeService({ adminEmails: 'other@example.com' });
      await expect(service.isModerator(actor)).resolves.toBe(false);
    });
  });

  describe('источник — оба', () => {
    it('роли складываются, а не заменяют друг друга', async () => {
      const { service } = makeService({
        dbRoles: [{ role: { name: 'lawyer' } }],
        adminEmails: 'staff@example.com',
        managerEmails: 'staff@example.com',
      });
      await expect(service.rolesOf(actor)).resolves.toEqual(
        new Set(['lawyer', 'admin', 'content_manager']),
      );
      await expect(service.isAdmin(actor)).resolves.toBe(true);
    });

    it('повтор одной роли в обоих источниках не двоится', async () => {
      const { service } = makeService({
        dbRoles: [{ role: { name: 'admin' } }],
        adminEmails: 'staff@example.com',
      });
      await expect(service.rolesOf(actor)).resolves.toEqual(new Set(['admin']));
    });
  });

  it('базовую роль user сам не добавляет — это дело вызывающего', async () => {
    const { service } = makeService({ dbRoles: [{ role: { name: 'admin' } }] });
    await expect(service.rolesOf(actor)).resolves.not.toContain('user');
  });
});
