/* eslint-disable @typescript-eslint/no-unsafe-return */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleName, Language as PrismaLanguage, User } from '@prisma/client';
import { ACCOUNT_USER_SELECT } from '../../common/selects/account-user.select';
import { PUBLIC_COMMENT_USER_SELECT } from '../../common/selects/public-comment-user.select';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { rolesCache } from '../../common/roles/roles-cache';
import { Role } from '../../common/decorators/roles.decorator';
import { STAFF_ROLE_NAMES } from './users.constants';

/** Условие «сотрудник» в фильтре `staff`: только роли из `UserRole`. */
const STAFF_ROLE_CONDITION = {
  roles: { some: { role: { name: { in: [...STAFF_ROLE_NAMES] } } } },
};

describe('UsersService (unit)', () => {
  let service: UsersService;
  let prismaMock: any;
  let moderatorRoles: ModeratorRolesService;

  const baseUser: User = {
    id: 'u1',
    email: 'user@example.com',
    passwordHash: 'hash',
    name: 'John',
    avatarUrl: null,
    languagePreference: PrismaLanguage.en,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastLogin: null,
  } as any;

  beforeEach(() => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
      },
      userRole: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      role: {
        findUnique: jest.fn(),
      },
      comment: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      like: {
        deleteMany: jest.fn(),
      },
      bookshelf: { deleteMany: jest.fn() },
      readingProgress: { deleteMany: jest.fn() },
      viewStat: { updateMany: jest.fn() },
      mediaAsset: { updateMany: jest.fn() },
      $transaction: jest.fn((arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg(prismaMock);
      }),
    };

    // Настоящий `ModeratorRolesService` на тех же моках: сведение
    // `computeRoles` к нему (`LEGACY-111`) обязано сохранить поведение
    // один в один, и соседние спеки на роли это и проверяют.
    moderatorRoles = new ModeratorRolesService(prismaMock as unknown as PrismaService);
    service = new UsersService(prismaMock as unknown as PrismaService, moderatorRoles);

    // Кэш ролей общий на процесс (`LEGACY-112`) — гасить его надо на весь файл,
    // а не в одном вложенном блоке: первый же тест, который позовёт гвард,
    // потечёт в соседние.
    rolesCache.clear();
  });

  // Списки почт код под тестом не читает, но сторожа `LEGACY-170` их
  // выставляют. Снимать надо здесь: упавшее ожидание до `delete` в теле теста
  // не доходит и уносит переменную в соседние файлы.
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
    delete process.env.CONTENT_MANAGER_EMAILS;
  });

  /** `where`, с которым сервис реально пошёл в базу за страницей. */
  const whereOfLastList = (): unknown => {
    const calls = (prismaMock.user.findMany as jest.Mock).mock.calls;
    return calls[calls.length - 1][0].where;
  };

  it('me: роли считает ModeratorRolesService, а не собственная копия', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    const rolesOf = jest
      .spyOn(moderatorRoles, 'rolesOf')
      .mockResolvedValueOnce(new Set<RoleName>(['content_manager']));

    const res = await service.me('u1');

    expect(rolesOf).toHaveBeenCalledWith({ userId: 'u1', email: baseUser.email });
    expect(res.roles.sort()).toEqual(['content_manager', 'user']);
    // Своего чтения ролей у сервиса не осталось: мок сервиса решает всё.
    expect(prismaMock.userRole.findMany).not.toHaveBeenCalled();
  });

  it('me: throws NotFound if user missing', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.me('unknown')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('me: returns public user and baseline role user', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.userRole.findMany.mockResolvedValueOnce([]);
    const res = await service.me('u1');
    expect(res.email).toBe(baseUser.email);
    expect(res.roles).toContain('user');
  });

  // 🔴 Сторож `LEGACY-170`: почта в списках окружения роль не выдаёт, в
  // `/users/me` уезжает только то, что лежит в `UserRole`.
  it('me: ENV не поднимает до admin/content_manager', async () => {
    process.env.ADMIN_EMAILS = baseUser.email;
    process.env.CONTENT_MANAGER_EMAILS = baseUser.email;
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.userRole.findMany.mockResolvedValueOnce([]);
    const res = await service.me('u1');
    expect(res.roles).toEqual(['user']);
  });

  it('updateMe: updates allowed fields and returns public user', async () => {
    const updated = { ...baseUser, name: 'Jane', avatarUrl: 'a.png' } as User;
    prismaMock.user.update.mockResolvedValueOnce(updated);
    const res = await service.updateMe('u1', { name: 'Jane', avatarUrl: 'a.png' });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { name: 'Jane', avatarUrl: 'a.png' },
      select: ACCOUNT_USER_SELECT,
    });
    expect(res.name).toBe('Jane');
    expect((res as any).passwordHash).toBeUndefined();
  });

  it('deleteById: NotFound when user missing initially', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.deleteById('u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteById: performs cascading cleanup and returns public user', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    // comments authored by user
    (prismaMock.comment.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }]);
    (prismaMock.like.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.comment.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.comment.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
    (prismaMock.bookshelf.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.readingProgress.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.viewStat.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.mediaAsset.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.userRole.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prismaMock.user.delete as jest.Mock).mockResolvedValue(baseUser);

    const res = await service.deleteById('u1');
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.like.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prismaMock.comment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
    });
    expect(res.email).toBe(baseUser.email);
  });

  it('assignRole + revokeRole happy path', async () => {
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValue(baseUser);
    (prismaMock.role.findUnique as jest.Mock).mockResolvedValue({
      id: 'r1',
      name: 'admin' as RoleName,
    });
    const upsert = jest.fn().mockResolvedValue({});
    prismaMock.userRole.upsert = upsert;
    const res = await service.assignRole('u1', 'admin');
    expect(upsert).toHaveBeenCalled();
    expect(res).toEqual({ userId: 'u1', role: 'admin' });

    const del = jest.fn().mockResolvedValue({});
    prismaMock.userRole.delete = del;
    const revoked = await service.revokeRole('u1', 'admin');
    expect(del).toHaveBeenCalledWith({ where: { userId_roleId: { userId: 'u1', roleId: 'r1' } } });
    expect(revoked).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('revokeRole: cannot revoke base user role', async () => {
    await expect(service.revokeRole('u1', 'user')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('assignRole: user or role not found', async () => {
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.assignRole('missing', 'admin')).rejects.toBeInstanceOf(NotFoundException);

    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);
    (prismaMock.role.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.assignRole('u1', 'admin')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokeRole: user or role not found (and non-existing link delete throws handled by service path)', async () => {
    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.revokeRole('missing', 'admin')).rejects.toBeInstanceOf(NotFoundException);

    (prismaMock.user.findUnique as jest.Mock).mockResolvedValueOnce(baseUser);
    (prismaMock.role.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.revokeRole('u1', 'admin')).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * `LEGACY-112`: кэш ролей в `RolesGuard` живёт до истечения TTL, поэтому
   * каждая запись в `UserRole` обязана его сбросить. Мест записи в этом сервисе
   * четыре — назначение, отзыв, удаление пользователя и замена набора ролей
   * в админской правке; проверяются все четыре, а не один метод из четырёх.
   * Полный перечень мест записи по всему `src`, вместе с теми, что сброса не
   * требуют, держит `src/common/roles/roles-cache-callers.spec.ts`.
   */
  describe('сброс кэша ролей после записи в UserRole', () => {
    const seed = (userId: string): void => {
      rolesCache.set(
        userId,
        new Set([Role.Admin]),
        Date.now() + 60_000,
        Date.now(),
        rolesCache.beginRead(),
      );
    };
    const cached = (userId: string): ReadonlySet<Role> | undefined =>
      rolesCache.get(userId, Date.now());

    beforeEach(() => {
      (prismaMock.user.findUnique as jest.Mock).mockResolvedValue(baseUser);
      (prismaMock.role.findUnique as jest.Mock).mockResolvedValue({
        id: 'r1',
        name: 'admin' as RoleName,
      });
      prismaMock.userRole.upsert = jest.fn().mockResolvedValue({});
      prismaMock.userRole.delete = jest.fn().mockResolvedValue({});
    });

    afterAll(() => rolesCache.clear());

    it('assignRole', async () => {
      seed('u1');
      await service.assignRole('u1', 'admin');
      expect(cached('u1')).toBeUndefined();
    });

    it('assignRole сбрасывает только названного — соседи в кэше остаются', async () => {
      seed('u1');
      seed('сосед');
      await service.assignRole('u1', 'admin');
      // `clear()` вместо `invalidate(userId)` отправил бы в базу всех вошедших.
      expect(cached('сосед')).toEqual(new Set([Role.Admin]));
    });

    it('revokeRole', async () => {
      seed('u1');
      await service.revokeRole('u1', 'admin');
      expect(cached('u1')).toBeUndefined();
    });

    it('deleteById', async () => {
      seed('u1');
      (prismaMock.comment.findMany as jest.Mock).mockResolvedValueOnce([]);
      (prismaMock.like.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prismaMock.bookshelf.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prismaMock.readingProgress.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prismaMock.viewStat.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prismaMock.mediaAsset.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prismaMock.userRole.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prismaMock.user.delete as jest.Mock).mockResolvedValue(baseUser);

      await service.deleteById('u1');
      expect(cached('u1')).toBeUndefined();
    });

    it('update с новым набором ролей', async () => {
      seed('u1');
      prismaMock.role.findMany = jest.fn().mockResolvedValue([{ id: 'r1', name: 'admin' }]);
      prismaMock.userRole.createMany = jest.fn().mockResolvedValue({ count: 1 });
      (prismaMock.userRole.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prismaMock.user.update as jest.Mock).mockResolvedValue(baseUser);
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

      await service.update('u1', { roles: ['admin'] });
      expect(cached('u1')).toBeUndefined();
    });

    it('update без ролей кэш не трогает — сброс не веерный', async () => {
      seed('u1');
      (prismaMock.user.update as jest.Mock).mockResolvedValue(baseUser);
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

      await service.update('u1', { firstName: 'Jane' });
      expect(cached('u1')).toEqual(new Set([Role.Admin]));
    });
  });

  it('list: pagination boundaries and staff=exclude filter', async () => {
    const uA = { ...baseUser, id: 'uA', email: 'admin@example.com' } as User;
    const uB = { ...baseUser, id: 'uB', email: 'plain@example.com' } as User;
    (prismaMock.user.count as jest.Mock).mockResolvedValue(2);
    (prismaMock.user.findMany as jest.Mock).mockResolvedValue([uA, uB]);
    (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

    const res = await service.list({ page: 1, limit: 1, staff: 'exclude' });
    expect(res.page).toBe(1);
    expect(res.limit).toBe(1);
    expect(Array.isArray(res.items)).toBe(true);
    // Условие проверяется целиком: снятое `NOT` тест обязан заметить, иначе
    // «не сотрудники» начнут включать админов.
    expect(whereOfLastList()).toEqual({
      AND: [{}, { NOT: STAFF_ROLE_CONDITION }],
    });
  });

  /**
   * 🔴 Сторож `LEGACY-170`. Раньше в фильтр подмешивались почты из
   * `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS`, и список сотрудников расходился
   * с тем, что решает `RolesGuard`: в админке человек значился сотрудником, а
   * на маршрут его не пускали. Сотрудник определяется строками `UserRole`.
   */
  it('list: staff=only фильтрует по ролям в базе, а не по спискам почт', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const uA = { ...baseUser, id: 'uA', email: 'admin@example.com' } as User;
    (prismaMock.user.count as jest.Mock).mockResolvedValue(1);
    (prismaMock.user.findMany as jest.Mock).mockResolvedValue([uA]);
    // Список считает роли пакетно (`LEGACY-125`), поэтому строка связи несёт
    // `userId`: по нему роль и раскладывается по пользователям.
    (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([
      { userId: 'uA', role: { name: 'admin' } },
    ]);

    const res = await service.list({ page: 1, limit: 10, staff: 'only' });

    expect(prismaMock.$transaction).toHaveBeenCalled();
    // Условие сверяется целиком, а не одним отрицанием: пустой `where` такую
    // проверку не пройдёт, а `staff=only` без условия отдал бы в админский
    // список сотрудников всех читателей подряд.
    expect(whereOfLastList()).toEqual({ AND: [{}, STAFF_ROLE_CONDITION] });
    expect(JSON.stringify(whereOfLastList())).not.toContain('admin@example.com');
    expect(res.items.find((i) => i.email === 'admin@example.com')!.roles).toContain('admin');
  });

  /**
   * 🔴 `LEGACY-125`. Список пользователей считал роли поштучно: на каждую
   * строку - свой `userRole.findMany`, то есть при `limit=50` пятьдесят лишних
   * запросов на один просмотр таблицы. Ответ при этом был верен до последнего
   * поля, и заметить дефект можно только по **числу** обращений к базе -
   * отсюда `toHaveBeenCalledTimes`, а не `toHaveBeenCalledWith`.
   */
  describe('list: роли считаются одним запросом (LEGACY-125)', () => {
    const tenUsers = Array.from(
      { length: 10 },
      (_, i) => ({ ...baseUser, id: `u${i}`, email: `u${i}@example.com` }) as User,
    );

    beforeEach(() => {
      (prismaMock.user.count as jest.Mock).mockResolvedValue(tenUsers.length);
      (prismaMock.user.findMany as jest.Mock).mockResolvedValue(tenUsers);
    });

    it('на 10 пользователях userRole.findMany зовётся ровно один раз', async () => {
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

      await service.list({ page: 1, limit: 10 });

      expect(prismaMock.userRole.findMany).toHaveBeenCalledTimes(1);
      const [args] = (prismaMock.userRole.findMany as jest.Mock).mock.calls[0];
      expect(args.where).toEqual({ userId: { in: tenUsers.map((u) => u.id) } });
    });

    it('роль из UserRole достаётся своему пользователю, а не всем подряд', async () => {
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([
        { userId: 'u3', role: { name: 'content_manager' } },
      ]);

      const res = await service.list({ page: 1, limit: 10 });

      expect(res.items.find((i) => i.id === 'u3')!.roles.sort()).toEqual(
        ['content_manager', 'user'].sort(),
      );
      expect(res.items.find((i) => i.id === 'u4')!.roles).toEqual(['user']);
    });

    /**
     * Базовая `user` - свойство выдачи этой ручки. Пакетный путь обязан отдавать
     * тот же состав, что и одиночный `computeRoles`, иначе у половины ответов
     * пропадёт роль, которой нет ни в одной строке `UserRole`.
     */
    it('базовая роль user есть у каждого, в том числе без связей в UserRole', async () => {
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

      const res = await service.list({ page: 1, limit: 10 });

      for (const item of res.items) {
        expect(item.roles).toContain('user');
      }
    });

    /**
     * 🔴 Пакет обязан идти через `ModeratorRolesService` (`LEGACY-111`).
     * Сторож на число запросов этого не показывает: спека держит настоящий
     * сервис на том же моке, поэтому прямой `userRole.findMany` из
     * `UsersService` дал бы ровно тот же единственный вызов - и второй
     * источник ролей завёлся бы незаметно.
     */
    it('роли берутся через ModeratorRolesService, а не своим запросом', async () => {
      const spy = jest.spyOn(moderatorRoles, 'rolesOfMany');
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

      await service.list({ page: 1, limit: 10 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(tenUsers.map((u) => u.id));
      spy.mockRestore();
    });

    it('на пустой странице в базу за ролями не ходит вовсе', async () => {
      (prismaMock.user.count as jest.Mock).mockResolvedValue(0);
      (prismaMock.user.findMany as jest.Mock).mockResolvedValue([]);

      const res = await service.list({ page: 7, limit: 10 });

      expect(res.items).toEqual([]);
      expect(prismaMock.userRole.findMany).toHaveBeenCalledTimes(0);
    });

    /**
     * ⚠️ Сторож `LEGACY-170` со стороны выдачи: почта из `ADMIN_EMAILS` роль
     * времени выполнения не даёт - ни в одиночном пути, ни в пакетном. Раньше
     * запись `125` требовала обратного; правило поменялось решением владельца
     * 15.08.2026, и здесь закреплено действующее.
     */
    it('почта из ADMIN_EMAILS роли не добавляет', async () => {
      process.env.ADMIN_EMAILS = 'u0@example.com';
      (prismaMock.userRole.findMany as jest.Mock).mockResolvedValue([]);

      const res = await service.list({ page: 1, limit: 10 });

      expect(res.items.find((i) => i.id === 'u0')!.roles).toEqual(['user']);
    });
  });

  describe('updateMe (nickname)', () => {
    it('throws ConflictException if nickname is already taken', async () => {
      prismaMock.user.findFirst.mockResolvedValueOnce({ id: 'u2', nickname: 'taken_nick' });
      await expect(service.updateMe('u1', { nickname: 'taken_nick' })).rejects.toThrow(
        'Nickname is already in use',
      );
    });

    it('updates nickname successfully if not taken', async () => {
      prismaMock.user.findFirst.mockResolvedValueOnce(null);
      prismaMock.user.update.mockResolvedValueOnce({ ...baseUser, nickname: 'new_nick' });
      const res = await service.updateMe('u1', { nickname: 'new_nick' });
      expect(res.nickname).toBe('new_nick');
    });
  });

  describe('getActivities', () => {
    it('returns comment threads with book version details', async () => {
      const mockComment = {
        id: 'c1',
        text: 'hello',
        createdAt: new Date(),
        parentId: null,
        parent: null,
        children: [
          {
            id: 'c2',
            text: 'reply',
            createdAt: new Date(),
            user: { id: 'u2', name: 'Replier' },
          },
        ],
        bookVersion: {
          id: 'v1',
          title: 'Book Title',
          author: 'Author Name',
          coverImageUrl: 'cover.jpg',
          book: { slug: 'book-slug' },
        },
      };
      prismaMock.comment.findMany.mockResolvedValueOnce([mockComment]);
      const res = await service.getActivities('u1');
      expect(res.length).toBe(1);
      expect(res[0].text).toBe('hello');
      expect(res[0].bookVersion).toEqual({
        id: 'v1',
        title: 'Book Title',
        author: 'Author Name',
        coverImageUrl: 'cover.jpg',
        slug: 'book-slug',
      });
      expect(res[0].replies.length).toBe(1);
      expect(res[0].replies[0].text).toBe('reply');
    });

    // Посадка LEGACY-191: `parent.user` — автор чужого комментария, `children.user` —
    // все, кто ответил, и то и другое третьи лица. Проверяются **аргументы** запроса,
    // а не форма ответа: ответ собирается из мока и о составе селекта ничего не знает.
    //
    // Два утверждения на каждый селект, и они закрывают разные дыры. `toEqual`
    // требует ровно общий белый список — иначе инлайн-литерал с любым другим полем
    // схемы (`passwordHash` в том числе) проходил бы мимо проверки на почту.
    // `not.toContain('email')` смотрит на состав ключей уже самой константы: её
    // расширение почтой `toEqual` не заметит, потому что сравнивает её саму с собой.
    it('не запрашивает почту авторов чужих комментариев (LEGACY-191)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      await service.getActivities('u1');

      expect(prismaMock.comment.findMany as jest.Mock).toHaveBeenCalledTimes(1);
      const args = (prismaMock.comment.findMany as jest.Mock).mock.calls[0][0] as {
        include: {
          parent: { include: { user: { select: Record<string, unknown> } } };
          children: { include: { user: { select: Record<string, unknown> } } };
        };
      };

      expect(args.include.parent.include.user.select).toEqual(PUBLIC_COMMENT_USER_SELECT);
      expect(args.include.children.include.user.select).toEqual(PUBLIC_COMMENT_USER_SELECT);
      expect(Object.keys(PUBLIC_COMMENT_USER_SELECT)).not.toContain('email');
    });

    // Посадка LEGACY-210: владелец страницы активности не модератор, и ветка ему
    // положена в том же виде, что анониму. Сверяются аргументы запроса: ответ
    // собирается из мока и о `where` ничего не знает.
    //
    // 🔴 Точное равенство объекта, а не `toHaveProperty('isHidden')`: последнее
    // прошло бы и на `isHidden: true`, то есть на выдаче одних только скрытых.
    it('не запрашивает скрытые модератором ответы (LEGACY-210)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      await service.getActivities('u1');

      expect(prismaMock.comment.findMany as jest.Mock).toHaveBeenCalledTimes(1);
      const args = (prismaMock.comment.findMany as jest.Mock).mock.calls[0][0] as {
        include: { children: { where: Record<string, unknown> } };
      };

      expect(args.include.children.where).toEqual({ isDeleted: false, isHidden: false });
    });

    // Вторая половина той же записи: у `parent` фильтра в запросе нет вовсе —
    // связь «к одному» не принимает `where` внутри `include`, — поэтому скрытый
    // родитель отсеивается в памяти наравне с удалённым.
    it('не отдаёт активность под скрытым родителем (LEGACY-210)', async () => {
      const base = {
        text: 'mine',
        createdAt: new Date(),
        children: [],
        bookVersion: null,
        chapter: null,
        audioChapter: null,
      };
      prismaMock.comment.findMany.mockResolvedValueOnce([
        {
          ...base,
          id: 'c1',
          parentId: 'p1',
          parent: {
            id: 'p1',
            text: 'hidden parent',
            createdAt: new Date(),
            isDeleted: false,
            isHidden: true,
            user: { id: 'u2' },
          },
        },
        {
          ...base,
          id: 'c2',
          parentId: 'p2',
          parent: {
            id: 'p2',
            text: 'visible parent',
            createdAt: new Date(),
            isDeleted: false,
            isHidden: false,
            user: { id: 'u3' },
          },
        },
        // Удалённый родитель отсеивался и до правки. Третий случай стоит здесь,
        // потому что выражение переписано целиком: без него снятие
        // `!c.parent.isDeleted` не покраснит ни один тест (урок `L-004`).
        {
          ...base,
          id: 'c3',
          parentId: 'p3',
          parent: {
            id: 'p3',
            text: 'deleted parent',
            createdAt: new Date(),
            isDeleted: true,
            isHidden: false,
            user: { id: 'u4' },
          },
        },
      ]);

      const res = await service.getActivities('u1');

      expect(res.map((r) => r.id)).toEqual(['c2']);
    });
  });

  // Посадка LEGACY-116: чтения пользователя сужены белым списком, и хеш пароля
  // не попадает ни в аргументы запроса, ни в ответ. Возврат запроса без
  // `select` красит эти спеки.
  describe('passwordHash не читается из базы (LEGACY-116)', () => {
    /** Аргументы всех вызовов Prisma, где выбирались поля пользователя. */
    function selectsOf(fn: jest.Mock): Record<string, unknown>[] {
      return fn.mock.calls.map((c) => (c[0] as { select?: Record<string, unknown> }).select ?? {});
    }

    it('me: findUnique зовётся с select без passwordHash', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
      prismaMock.userRole.findMany.mockResolvedValueOnce([]);
      await service.me('u1');

      const [select] = selectsOf(prismaMock.user.findUnique as jest.Mock);
      expect(select).toEqual(ACCOUNT_USER_SELECT);
      expect(select).not.toHaveProperty('passwordHash');
    });

    it('me: в ответе нет ключа passwordHash', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
      prismaMock.userRole.findMany.mockResolvedValueOnce([]);
      const res = await service.me('u1');

      expect(Object.keys(res)).not.toContain('passwordHash');
    });

    it('list: findMany зовётся с select без passwordHash', async () => {
      (prismaMock.user.count as jest.Mock).mockResolvedValueOnce(1);
      (prismaMock.user.findMany as jest.Mock).mockResolvedValueOnce([baseUser]);
      prismaMock.userRole.findMany.mockResolvedValue([]);
      await service.list({ page: 1, limit: 10 });

      const [select] = selectsOf(prismaMock.user.findMany as jest.Mock);
      expect(select).toEqual(ACCOUNT_USER_SELECT);
      expect(select).not.toHaveProperty('passwordHash');
    });

    it('list: ни в одном элементе ответа нет ключа passwordHash', async () => {
      (prismaMock.user.count as jest.Mock).mockResolvedValueOnce(1);
      (prismaMock.user.findMany as jest.Mock).mockResolvedValueOnce([baseUser]);
      prismaMock.userRole.findMany.mockResolvedValue([]);
      const res = await service.list({ page: 1, limit: 10 });

      expect(res.items).toHaveLength(1);
      for (const item of res.items) {
        expect(Object.keys(item)).not.toContain('passwordHash');
      }
    });

    it('проверка существования читает только id', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      prismaMock.userRole.findMany.mockResolvedValueOnce([]);
      await service.listRoles('u1');

      const [select] = selectsOf(prismaMock.user.findUnique as jest.Mock);
      expect(select).toEqual({ id: true });
    });

    // 🔴 Отдельно от чтений: `create`, `update` и `delete` возвращают строку
    // пользователя точно так же, как `findUnique`, и без `select` отдают хеш.
    // Без этих спек возврат `include`/безусловной записи проходит незамеченным.
    it('create: запись зовётся с select без passwordHash', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce(null);
      (prismaMock.user.create as jest.Mock).mockResolvedValueOnce({
        ...baseUser,
        roles: [{ role: { name: 'user' } }],
      });

      await service.create({
        email: 'new@example.com',
        password: 'secret-password',
        roles: [RoleName.user],
      } as any);

      const [select] = selectsOf(prismaMock.user.create as jest.Mock);
      expect(select).not.toHaveProperty('passwordHash');
      expect(select).toMatchObject(ACCOUNT_USER_SELECT);
      // Проверка занятости почты читает только идентификатор.
      expect(selectsOf(prismaMock.user.findUnique as jest.Mock)[0]).toEqual({ id: true });
    });

    it('update: чтение и запись сужены, passwordHash не читается', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        firstName: 'John',
        lastName: null,
      });
      prismaMock.user.update.mockResolvedValueOnce(baseUser);
      prismaMock.userRole.findMany.mockResolvedValue([]);

      await service.update('u1', { nickname: 'new_nick' } as any);

      const [readSelect] = selectsOf(prismaMock.user.findUnique as jest.Mock);
      expect(readSelect).not.toHaveProperty('passwordHash');
      expect(Object.keys(readSelect).sort()).toEqual(['firstName', 'id', 'lastName']);

      const [writeSelect] = selectsOf(prismaMock.user.update as jest.Mock);
      expect(writeSelect).toEqual(ACCOUNT_USER_SELECT);
    });

    it('deleteById: удаление зовётся с select без passwordHash', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      (prismaMock.comment.findMany as jest.Mock).mockResolvedValueOnce([]);
      prismaMock.user.delete.mockResolvedValueOnce(baseUser);

      await service.deleteById('u1');

      const [deleteSelect] = selectsOf(prismaMock.user.delete as jest.Mock);
      expect(deleteSelect).toEqual(ACCOUNT_USER_SELECT);
      expect(selectsOf(prismaMock.user.findUnique as jest.Mock)[0]).toEqual({ id: true });
    });

    it('ни одна операция над пользователем не идёт без select', async () => {
      prismaMock.user.findFirst.mockResolvedValueOnce(null);
      prismaMock.user.update.mockResolvedValueOnce(baseUser);
      await service.updateMe('u1', { nickname: 'free_nick' });

      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: RoleName.admin });
      await service.assignRole('u1', RoleName.admin);

      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: RoleName.admin });
      await service.revokeRole('u1', RoleName.admin);

      const calls = [
        ...(prismaMock.user.findUnique as jest.Mock).mock.calls,
        ...(prismaMock.user.findFirst as jest.Mock).mock.calls,
        ...(prismaMock.user.update as jest.Mock).mock.calls,
      ];
      expect(calls.length).toBeGreaterThan(0);
      for (const [args] of calls) {
        expect(args).toHaveProperty('select');
        expect(args.select).not.toHaveProperty('passwordHash');
      }
    });
  });
});
