import { NotFoundException, BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RoleName,
  Language as PrismaLanguage,
  User,
  Prisma,
  AdminAuditAction,
  AdminAuditTargetType,
} from '@prisma/client';
import { ACCOUNT_USER_SELECT } from '../../common/selects/account-user.select';
import { PUBLIC_COMMENT_USER_SELECT } from '../../common/selects/public-comment-user.select';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { rolesCache } from '../../common/roles/roles-cache';
import { sessionStateCache } from '../../shared/session/session-state-cache';
import { Role } from '../../common/decorators/roles.decorator';
import { STAFF_ROLE_NAMES } from './users.constants';
import type { StorageService } from '../../shared/storage/storage.interface';

// Настоящий хеш, обёрнутый в jest.fn: посадка LEGACY-425 смотрит, считался ли он вообще.
jest.mock('argon2', () => {
  const actual = jest.requireActual<typeof import('argon2')>('argon2');
  return { ...actual, hash: jest.fn(actual.hash) };
});

/** Условие «сотрудник» в фильтре `staff`: только роли из `UserRole`. */
const STAFF_ROLE_CONDITION = {
  roles: { some: { role: { name: { in: [...STAFF_ROLE_NAMES] } } } },
};

/**
 * Аргумент `$transaction`. Колбэчная ветка записана образцом из
 * `book-version.service.spec.ts`: на место `tx` приходит сам стаб, а возврат
 * колбэка становится возвратом транзакции. Списочную форму Prisma принимает
 * наравне с колбэком, и `list()` с `getActivities()` зовут именно её, поэтому
 * она остаётся вторым вариантом аргумента.
 */
type TransactionArg<T = unknown> = Promise<T>[] | ((tx: PrismaStub) => Promise<T> | T);

/**
 * Заглушка клиента Prisma: у каждой модели объявлены ровно те методы, которые
 * зовёт `UsersService`. Необязательные поля общий стенд не заводит - их
 * подставляют отдельные тесты, и именно поэтому они помечены `?`.
 */
interface PrismaStub {
  user: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  userRole: {
    findMany: jest.Mock;
    deleteMany: jest.Mock;
    createMany: jest.Mock;
    delete: jest.Mock;
  };
  role: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  comment: {
    findMany: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  like: { deleteMany: jest.Mock };
  bookshelf: { deleteMany: jest.Mock };
  readingProgress: { deleteMany: jest.Mock };
  viewStat: { updateMany: jest.Mock };
  mediaAsset: { updateMany: jest.Mock };
  adminAuditEvent: { createMany: jest.Mock };
  // Замок строки `User` (`lockUserRow`): тегированный шаблон, первый аргумент — части SQL.
  $queryRaw: jest.Mock;
  // Второй параметр — `{ timeout, maxWait }` (`USER_WRITE_TX_OPTIONS`). Он объявлен здесь,
  // а не опущен, потому что это поведение: на дефолтах Prisma смена набора ролей на занятом
  // пуле отдаёт `P2028`, и посадка на эти значения читает именно `mock.calls[0][1]`.
  $transaction: jest.Mock<
    Promise<unknown>,
    [TransactionArg, { timeout: number; maxWait: number }?]
  >;
}

/** Публичная база загрузки: так `R2StorageService` строит адрес с префиксом ключей. */
const STORAGE_BASE = 'https://media.example.test/uploads';
const storageStub = { getPublicUrl: (key: string) => `${STORAGE_BASE}/${key}` };

describe('UsersService (unit)', () => {
  let service: UsersService;
  let prismaMock: PrismaStub;
  let moderatorRoles: ModeratorRolesService;
  // Общий писатель журнала подменён целиком: сервис зовёт его на удалении
  // пользователя (`LEGACY-015`), и посадкам важно, каким клиентом он позван.
  let adminAudit: { record: jest.Mock };

  const baseUser: User = {
    id: 'u1',
    email: 'user@example.com',
    passwordHash: 'hash',
    name: 'John',
    firstName: null,
    lastName: null,
    nickname: null,
    isActive: true,
    tokenVersion: 0,
    avatarUrl: null,
    languagePreference: PrismaLanguage.en,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastLogin: null,
  };

  beforeEach(() => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
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
        createMany: jest.fn(),
        delete: jest.fn(),
      },
      role: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      comment: {
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
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
      adminAuditEvent: { createMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'u1' }]),
      $transaction: jest.fn(async (arg: TransactionArg) => {
        if (typeof arg === 'function') {
          return arg(prismaMock);
        }
        return Promise.all(arg);
      }),
    };

    // Настоящий `ModeratorRolesService` на тех же моках: сведение
    // `computeRoles` к нему (`LEGACY-111`) обязано сохранить поведение
    // один в один, и соседние спеки на роли это и проверяют.
    moderatorRoles = new ModeratorRolesService(prismaMock as unknown as PrismaService);
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new UsersService(
      prismaMock as unknown as PrismaService,
      moderatorRoles,
      adminAudit as unknown as AdminAuditService,
      storageStub as unknown as StorageService,
    );

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
    const calls = prismaMock.user.findMany.mock.calls;
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
    const avatarUrl = `${STORAGE_BASE}/avatars/u1/a.png`;
    const updated = { ...baseUser, name: 'Jane', avatarUrl } as User;
    prismaMock.user.update.mockResolvedValueOnce(updated);
    const res = await service.updateMe('u1', { name: 'Jane', avatarUrl });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { name: 'Jane', avatarUrl },
      select: ACCOUNT_USER_SELECT,
    });
    expect(res.name).toBe('Jane');
    expect((res as { passwordHash?: string }).passwordHash).toBeUndefined();
  });

  describe('updateMe: аватар только из нашего хранилища (LEGACY-455)', () => {
    it.each([
      ['чужой хост', 'https://tracker.example.com/pixel.png'],
      ['наш хост префиксом чужого', 'https://media.example.test.evil.com/uploads/a.png'],
      ['учётка в адресе', 'https://media.example.test@evil.com/uploads/a.png'],
      ['наш хост, путь мимо базы', 'https://media.example.test/other/a.png'],
      ['соседний префикс', 'https://media.example.test/uploads-other/a.png'],
      ['другая схема', 'http://media.example.test/uploads/a.png'],
      ['сама база без файла', `${STORAGE_BASE}/`],
    ])('%s — 400, профиль не пишется', async (_name, avatarUrl) => {
      await expect(service.updateMe('u1', { avatarUrl })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('уже сохранённый внешний аватар (провайдера) принимается как есть', async () => {
      const avatarUrl = 'https://lh3.googleusercontent.com/a/photo';
      prismaMock.user.findUnique.mockResolvedValueOnce({ avatarUrl });
      prismaMock.user.update.mockResolvedValueOnce({ ...baseUser, avatarUrl } as User);
      await service.updateMe('u1', { name: 'Jane', avatarUrl });
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    });

    it('сохранён внешний аватар A, прислан внешний B — 400, чтение текущего узкое', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
      });
      await expect(
        service.updateMe('u1', { avatarUrl: 'https://tracker.example.com/pixel.png' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { avatarUrl: true },
      });
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('avatarUrl: null — снятие аватара, как до правила', async () => {
      prismaMock.user.update.mockResolvedValueOnce({ ...baseUser, avatarUrl: null } as User);
      await service.updateMe('u1', { avatarUrl: null as unknown as string });
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    });

    it('без аватара в теле проверки нет — остальные поля пишутся', async () => {
      prismaMock.user.update.mockResolvedValueOnce({ ...baseUser, name: 'Jane' } as User);
      await service.updateMe('u1', { name: 'Jane' });
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    });
  });

  it('deleteById: NotFound when user missing initially', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.deleteById('u1', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteById: performs cascading cleanup and returns public user', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    // замок пользователя, цели его контента, затем комментарии автора под замком (`T101`)
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValueOnce([])
      // своих два и чужой прямой ответ: он заперт той же выборкой, но не удаляется (`T101`)
      .mockResolvedValueOnce([
        { id: 'c1', userId: 'u1' },
        { id: 'c2', userId: 'u1' },
        { id: 'r9', userId: 'u9' },
      ]);
    prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.comment.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.comment.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.userRole.findMany.mockResolvedValueOnce([]);
    prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.user.delete.mockResolvedValue(baseUser);

    const res = await service.deleteById('u1', 'admin-1');
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.like.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prismaMock.comment.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.comment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
    });
    expect(prismaMock.comment.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.comment.updateMany).toHaveBeenCalledWith({
      where: { parentId: { in: ['c1', 'c2'] } },
      data: { parentId: null },
    });
    expect(res.email).toBe(baseUser.email);
  });

  /**
   * `LEGACY-015`. Удаление снимает роли оператором `userRole.deleteMany`, и до 20.09.2026
   * не писало об этом ни строки: по журналу роль оставалась у пользователя, которого нет.
   * Тест смотрит на **состав** событий и на клиент, которым они записаны, а не на факт
   * вызова: запись мимо транзакции переживает её откат (`LEGACY-036`).
   */
  it('удаление пользователя пишет ROLE_REVOKED на каждую снятую роль и USER_DELETED (LEGACY-015)', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    // Клиент транзакции собран **отдельным** объектом, а не дефолтным стабом: тот
    // отдаёт в колбэк сам `prismaMock`, которым сконструирован и сервис, поэтому
    // `tx` и `this.prisma` там неотличимы по ссылке и подмена одного другим оставляет
    // спеку зелёной (`LEGACY-036`). Приём взят у соседней посадки на `update` ниже.
    const txRolesFindMany = jest
      .fn()
      .mockResolvedValue([
        { role: { name: 'admin' as RoleName } },
        { role: { name: 'user' as RoleName } },
      ]);
    const txRolesDeleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const txUserDelete = jest.fn().mockResolvedValue(baseUser);
    let txClient: unknown;
    prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      txClient = {
        ...prismaMock,
        user: { ...prismaMock.user, delete: txUserDelete },
        userRole: {
          ...prismaMock.userRole,
          findMany: txRolesFindMany,
          deleteMany: txRolesDeleteMany,
        },
      };
      return arg(txClient as PrismaStub);
    });

    await service.deleteById('u1', 'admin-7');

    // Прежний набор читается **до** снятия: после `deleteMany` ответить, что именно
    // сняли, неоткуда.
    expect(txRolesFindMany).toHaveBeenCalledTimes(1);
    expect(txRolesFindMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { role: { select: { name: true } } },
    });
    expect(txUserDelete).toHaveBeenCalledTimes(1);

    // Модель `adminAuditEvent` больше не трогается напрямую: ролевой писатель переехал
    // на общий `AdminAuditService` (`LEGACY-015`, пункт 6).
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();

    // Ролевые события — по одному вызову общего писателя на снятую роль, тем же
    // клиентом транзакции: сравнение идёт с тем самым объектом, который стенд отдал
    // в колбэк, а он не равен `prismaMock`, то есть подмена `tx` на `this.prisma`
    // красит эти строки. Событие о самой строке пользователя пишется третьим, после
    // обоих отзывов ролей — тем же клиентом.
    expect(adminAudit.record).toHaveBeenCalledTimes(3);
    expect(adminAudit.record).toHaveBeenNthCalledWith(1, txClient, {
      action: AdminAuditAction.ROLE_REVOKED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      actorUserId: 'admin-7',
      payload: { role: 'admin' },
    });
    expect(adminAudit.record).toHaveBeenNthCalledWith(2, txClient, {
      action: AdminAuditAction.ROLE_REVOKED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      actorUserId: 'admin-7',
      payload: { role: 'user' },
    });
    expect(adminAudit.record).toHaveBeenNthCalledWith(3, txClient, {
      action: AdminAuditAction.USER_DELETED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      actorUserId: 'admin-7',
    });
  });

  it('удаление пользователя без ролей событий об отзыве не пишет (LEGACY-015)', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.userRole.findMany.mockResolvedValueOnce([]);
    prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.user.delete.mockResolvedValue(baseUser);

    await service.deleteById('u1', 'admin-7');

    // Инвариант «событие = изменение состояния»: снимать было нечего, значит строка
    // `ROLE_REVOKED` утверждала бы отзыв, которого не было. Само удаление при этом
    // состоялось, и событие о нём пишется.
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
  });

  it('assignRole + revokeRole happy path', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({
      id: 'r1',
      name: 'admin' as RoleName,
    });
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    prismaMock.userRole.createMany = createMany;
    const res = await service.assignRole('u1', 'admin', 'admin-1');
    expect(createMany).toHaveBeenCalled();
    expect(res).toEqual({ userId: 'u1', role: 'admin' });

    const del = jest.fn().mockResolvedValue({});
    prismaMock.userRole.delete = del;
    const revoked = await service.revokeRole('u1', 'admin', 'admin-1');
    expect(del).toHaveBeenCalledWith({ where: { userId_roleId: { userId: 'u1', roleId: 'r1' } } });
    expect(revoked).toEqual({ userId: 'u1', role: 'admin' });
  });

  /**
   * 🔴 LEGACY-015. Состояние базы отвечает «как сейчас», но не «кто и когда»: снятую роль
   * после отзыва не отличить от никогда не выданной. Посадки ниже держат журнал сразу
   * по четырём осям: событие пишется, пишется с верным актёром и действием, пишется
   * **в той же транзакции**, что смена роли, и пишется **только на изменение состояния**.
   *
   * ⚠️ Значения `action` и `targetType` сверяются литералами, а не через `AdminAuditAction`:
   * в базу уходит именно строка, и ссылка на перечисление молча проехала бы переименование
   * его значения вместе с сервисом.
   */
  it('assignRole: пишет событие журнала с актёром и ролью', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    // `count: 1` — роль вставлена этим запросом. Именно вставка, а не отдельное чтение,
    // и есть признак изменения состояния.
    prismaMock.userRole.createMany.mockResolvedValue({ count: 1 });

    await service.assignRole('u1', 'admin', 'admin-1');

    // Число вставок закреплено вместе с их формой: именно `count` этой единственной
    // вставки решает, писать ли строку журнала. Вторая вставка рядом дала бы две роли
    // и одно событие — по журналу вторая роль оказалась бы выдана никем.
    expect(prismaMock.userRole.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u1', roleId: 'r1' }],
      skipDuplicates: true,
    });
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record).toHaveBeenCalledWith(expect.anything(), {
      actorUserId: 'admin-1',
      action: 'ROLE_ASSIGNED',
      targetType: 'USER',
      targetId: 'u1',
      payload: { role: 'admin' },
    });
  });

  /**
   * Инвариант «событие = изменение состояния». Повторная выдача уже имеющейся роли
   * состояния не меняет, и строка в журнале солгала бы о втором наделении правами:
   * по такому журналу нельзя было бы сказать, когда роль выдали на самом деле.
   */
  it('assignRole: повторная выдача уже имеющейся роли события не пишет', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    // `count: 0` — `ON CONFLICT DO NOTHING` не вставил ничего: роль уже была.
    // Так же выглядит и проигранная гонка с параллельной выдачей — и это верно:
    // событие должен написать тот запрос, который роль действительно создал.
    prismaMock.userRole.createMany.mockResolvedValue({ count: 0 });

    await service.assignRole('u1', 'admin', 'admin-1');

    expect(prismaMock.userRole.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  it('revokeRole: пишет событие журнала с действием ROLE_REVOKED', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    prismaMock.userRole.delete = jest.fn().mockResolvedValue({});

    await service.revokeRole('u1', 'admin', 'admin-1');

    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record).toHaveBeenCalledWith(expect.anything(), {
      actorUserId: 'admin-1',
      action: 'ROLE_REVOKED',
      targetType: 'USER',
      targetId: 'u1',
      payload: { role: 'admin' },
    });
  });

  /**
   * Смена роли и запись о ней идут одним клиентом транзакции. Возврат к раздельным
   * записям (`this.prisma.userRole.*` вместо `tx.userRole.*`) роняет эту посадку:
   * вызов уедет на корневой клиент, и `tx` останется незатронутым.
   *
   * ⚠️ Посадка нужна **на каждом** пути записи отдельно: она ловит подмену клиента там,
   * где стоит, и молчит про соседний метод.
   */
  it('assignRole: смена роли и запись журнала идут одной транзакцией', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    const txWrite = jest.fn().mockResolvedValue({ count: 1 });
    let txClient: unknown;
    prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      txClient = {
        ...prismaMock,
        userRole: { ...prismaMock.userRole, createMany: txWrite },
      };
      return arg(txClient as PrismaStub);
    });

    await service.assignRole('u1', 'admin', 'admin-1');

    expect(txWrite).toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record).toHaveBeenCalledWith(txClient, {
      actorUserId: 'admin-1',
      action: AdminAuditAction.ROLE_ASSIGNED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      payload: { role: 'admin' },
    });
    expect(prismaMock.userRole.createMany).not.toHaveBeenCalled();
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  it('revokeRole: снятие роли и запись журнала идут одной транзакцией', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    const txDelete = jest.fn().mockResolvedValue({});
    let txClient: unknown;
    prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      txClient = {
        ...prismaMock,
        userRole: { ...prismaMock.userRole, delete: txDelete },
      };
      return arg(txClient as PrismaStub);
    });

    await service.revokeRole('u1', 'admin', 'admin-1');

    expect(txDelete).toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record).toHaveBeenCalledWith(txClient, {
      actorUserId: 'admin-1',
      action: AdminAuditAction.ROLE_REVOKED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      payload: { role: 'admin' },
    });
    expect(prismaMock.userRole.delete).not.toHaveBeenCalled();
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  /**
   * `P2025` — «роли не было»: состояние не изменилось, значит записывать нечего.
   * Событие при отказе создало бы след действия, которого не было.
   */
  it('revokeRole: при отсутствующей роли события журнала нет', async () => {
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    prismaMock.userRole.delete = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('nothing to delete', {
        code: 'P2025',
        clientVersion: 'test',
      }),
    );

    await expect(service.revokeRole('u1', 'admin', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  /**
   * 🔴 Основной путь админки — форма пользователя (`PATCH /users/:id`), а не ручки
   * `/roles/:role`. Без этой посадки журнал не молчал бы, а лгал: строка `ROLE_ASSIGNED`
   * пережила бы снятие роли через форму, и по журналу выходило бы, что роль на месте.
   */
  it('update: смена набора ролей пишет события по разнице наборов', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', firstName: null, lastName: null });
    prismaMock.user.update.mockResolvedValue(baseUser);
    prismaMock.role.findMany.mockResolvedValue([{ id: 'r2', name: 'content_manager' }]);
    // Было: `admin`. Станет: `content_manager`. Значит одна выдача и один отзыв.
    prismaMock.userRole.findMany.mockResolvedValue([{ role: { name: 'admin' } }]);
    prismaMock.userRole.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.userRole.createMany.mockResolvedValue({ count: 1 });

    await service.update('u1', { roles: ['content_manager'] }, 'admin-1');

    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(2);
    expect(adminAudit.record).toHaveBeenNthCalledWith(1, expect.anything(), {
      actorUserId: 'admin-1',
      action: 'ROLE_ASSIGNED',
      targetType: 'USER',
      targetId: 'u1',
      payload: { role: 'content_manager' },
    });
    expect(adminAudit.record).toHaveBeenNthCalledWith(2, expect.anything(), {
      actorUserId: 'admin-1',
      action: 'ROLE_REVOKED',
      targetType: 'USER',
      targetId: 'u1',
      payload: { role: 'admin' },
    });
  });

  it('update: замена набора ролей на такой же события не пишет', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', firstName: null, lastName: null });
    prismaMock.user.update.mockResolvedValue(baseUser);
    prismaMock.role.findMany.mockResolvedValue([{ id: 'r1', name: 'admin' }]);
    prismaMock.userRole.findMany.mockResolvedValue([{ role: { name: 'admin' } }]);
    prismaMock.userRole.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.userRole.createMany.mockResolvedValue({ count: 1 });

    await service.update('u1', { roles: ['admin'] }, 'admin-1');

    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  /**
   * Та же посадка, что у `assignRole`, но на основном пути админки. Без неё подмена
   * `recordRoleAuditEvents(tx, ...)` на корневой клиент в `update()` проходит все тесты:
   * дефолтный стаб `$transaction` отдаёт в колбэк сам `prismaMock`, и разницы не видно.
   */
  it('update: смена ролей и запись журнала идут одной транзакцией', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', firstName: null, lastName: null });
    prismaMock.userRole.findMany.mockResolvedValue([]);
    const txDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const txCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    let txClient: unknown;
    prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      txClient = {
        ...prismaMock,
        user: { ...prismaMock.user, update: jest.fn().mockResolvedValue(baseUser) },
        role: {
          ...prismaMock.role,
          findMany: jest.fn().mockResolvedValue([{ id: 'r1', name: 'admin' }]),
        },
        userRole: {
          ...prismaMock.userRole,
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: txDeleteMany,
          createMany: txCreateMany,
        },
      };
      return arg(txClient as PrismaStub);
    });

    await service.update('u1', { roles: ['admin'] }, 'admin-1');

    expect(txCreateMany).toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record).toHaveBeenCalledWith(txClient, {
      actorUserId: 'admin-1',
      action: AdminAuditAction.ROLE_ASSIGNED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      payload: { role: 'admin' },
    });
    expect(prismaMock.userRole.createMany).not.toHaveBeenCalled();
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  /**
   * 🔴 `LEGACY-015` пункт 5 (`T44`). Снимок ролей точен, только если прочитан после замка
   * строки `User`, и замок обязан быть у **всех** писателей ролей: без него у `assignRole`
   * встречная выдача между снимком и `deleteMany` в `update` оставляет в журнале роль, которой нет.
   */
  describe('замок строки User у писателей ролей', () => {
    type Writer = {
      name: string;
      strength: 'FOR NO KEY UPDATE' | 'FOR UPDATE';
      call: () => Promise<unknown>;
      // Операторы, которые обязаны идти после замка.
      after: () => jest.Mock[];
      // Записи, которых не должно быть, если строки под замком нет.
      writes: () => jest.Mock[];
      // Запросов после замка строки пользователя: у удаления — чтение целей его контента (`T97`).
      targetLocks?: number;
    };

    // Колбэк транзакции получает отдельный клиент со своим `$queryRaw`: замок, взятый корневым
    // клиентом, ушёл бы автокоммитом на другое соединение пула и снялся бы сразу (урок `T20`).
    let txQueryRaw: jest.Mock;

    beforeEach(() => {
      txQueryRaw = jest.fn().mockResolvedValue([{ id: 'u1' }]);
      prismaMock.$transaction.mockImplementation(async (arg: TransactionArg) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        return arg({ ...prismaMock, $queryRaw: txQueryRaw });
      });
      prismaMock.user.findUnique.mockResolvedValue(baseUser);
      prismaMock.user.update.mockResolvedValue(baseUser);
      prismaMock.user.delete.mockResolvedValue(baseUser);
      prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
      prismaMock.role.findMany.mockResolvedValue([{ id: 'r1', name: 'admin' }]);
      prismaMock.userRole.findMany.mockResolvedValue([]);
      prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.userRole.createMany.mockResolvedValue({ count: 1 });
      prismaMock.userRole.delete.mockResolvedValue({});
      prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    });

    const writers: Writer[] = [
      {
        name: 'update',
        strength: 'FOR NO KEY UPDATE',
        call: () => service.update('u1', { roles: ['admin'] }, 'admin-1'),
        after: () => [prismaMock.user.update, prismaMock.userRole.findMany],
        writes: () => [
          prismaMock.user.update,
          prismaMock.userRole.deleteMany,
          prismaMock.userRole.createMany,
          adminAudit.record,
        ],
      },
      {
        name: 'assignRole',
        strength: 'FOR NO KEY UPDATE',
        call: () => service.assignRole('u1', 'admin', 'admin-1'),
        after: () => [prismaMock.userRole.createMany],
        writes: () => [prismaMock.userRole.createMany, adminAudit.record],
      },
      {
        name: 'revokeRole',
        strength: 'FOR NO KEY UPDATE',
        call: () => service.revokeRole('u1', 'admin', 'admin-1'),
        after: () => [prismaMock.userRole.delete],
        writes: () => [prismaMock.userRole.delete, adminAudit.record],
      },
      {
        name: 'deleteById',
        strength: 'FOR UPDATE',
        call: () => service.deleteById('u1', 'admin-1'),
        after: () => [prismaMock.like.deleteMany, prismaMock.userRole.findMany],
        targetLocks: 2,
        writes: () => [
          prismaMock.like.deleteMany,
          prismaMock.userRole.deleteMany,
          prismaMock.user.delete,
          adminAudit.record,
        ],
      },
    ];

    it.each(writers)('$name: $strength на строку цели, клиентом транзакции, первым', async (w) => {
      await w.call();

      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(txQueryRaw).toHaveBeenCalledTimes(1 + (w.targetLocks ?? 0));
      const lock = txQueryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(lock.sql).toBe(`SELECT id FROM "User" WHERE id = ? ${w.strength}`);
      expect(lock.values).toEqual(['u1']);
      const lockAt = txQueryRaw.mock.invocationCallOrder[0];
      for (const op of w.after()) {
        expect(op).toHaveBeenCalled();
        expect(lockAt).toBeLessThan(op.mock.invocationCallOrder[0]);
      }
      // «Первым» — против всех вызовов стаба после открытия транзакции, а не только выбранных.
      const allMocks = (o: object): jest.Mock[] =>
        Object.values(o).flatMap((v: unknown) =>
          jest.isMockFunction(v) ? [v] : v && typeof v === 'object' ? allMocks(v) : [],
        );
      const txAt = prismaMock.$transaction.mock.invocationCallOrder[0];
      const insideTx = [...allMocks(prismaMock), adminAudit.record]
        .filter((m) => m !== prismaMock.$transaction)
        .flatMap((m) => m.mock.invocationCallOrder)
        .filter((at) => at > txAt);
      expect(insideTx.length).toBeGreaterThan(0);
      expect(Math.min(...insideTx)).toBeGreaterThan(lockAt);
    });

    it('deleteById: цели читаются один раз, затем книги и версии FOR KEY SHARE по id, версии сверки FOR NO KEY UPDATE, комментарии автора FOR UPDATE — до первой записи (LEGACY-433, T97, T101)', async () => {
      txQueryRaw
        .mockResolvedValueOnce([{ id: 'u1' }])
        .mockResolvedValueOnce([
          { kind: 'version', id: 'v2' },
          { kind: 'book', id: 'b1' },
          { kind: 'version', id: 'v1' },
          { kind: 'book', id: 'b9' },
          { kind: 'chapter', id: 'ch2' },
          { kind: 'audio', id: 'au1' },
          { kind: 'chapter', id: 'ch1' },
        ])
        .mockResolvedValueOnce([{ n: 2 }])
        .mockResolvedValueOnce([{ n: 2 }])
        .mockResolvedValueOnce([{ n: 0 }])
        .mockResolvedValueOnce([{ n: 2 }])
        .mockResolvedValueOnce([{ n: 1 }])
        .mockResolvedValue([{ id: 'c1', userId: 'u1' }]);

      await service.deleteById('u1', 'admin-1');

      expect(txQueryRaw).toHaveBeenCalledTimes(8);
      expect(prismaMock.comment.findMany).not.toHaveBeenCalled();
      const sqlAt = (i: number) => (txQueryRaw.mock.calls[i][0] as Prisma.Sql).sql;
      const valuesAt = (i: number) => (txQueryRaw.mock.calls[i][0] as Prisma.Sql).values;
      for (const source of [
        '"Like"',
        '"Comment"',
        '"Chapter"',
        '"AudioChapter"',
        '"Bookshelf"',
        '"ReadingProgress"',
        '"ViewStat"',
        '"BookRating"',
        '"rightsGeoBlockVerifiedByUserId"',
      ]) {
        expect(sqlAt(1)).toContain(source);
      }
      expect(sqlAt(1)).not.toMatch(/FOR (KEY SHARE|UPDATE|SHARE)/);
      expect(new Set(valuesAt(1))).toEqual(new Set(['u1']));
      expect(sqlAt(1)).toContain('FROM "BookVersion" WHERE "rightsGeoBlockVerifiedByUserId" = ?');
      // Один параметр-массив, а не список `IN`: предел числа параметров запроса не касается.
      expect(sqlAt(2)).toContain(
        'SELECT id FROM "Book" WHERE id = ANY(?::text[]) ORDER BY id FOR KEY SHARE',
      );
      expect(valuesAt(2)).toEqual([['b1', 'b9']]);
      expect(sqlAt(3)).toContain(
        'SELECT id FROM "BookVersion" WHERE id = ANY(?::text[]) ORDER BY id FOR KEY SHARE',
      );
      expect(valuesAt(3)).toEqual([['v2', 'v1']]);
      // Версии, где удаляемый — сверяющий гео-блокировки: `SetNull` при удалении строки
      // пользователя пишет их, и замок записи берётся до лайков, а не в самом конце.
      expect(sqlAt(4)).toMatch(
        /FROM "BookVersion" WHERE "rightsGeoBlockVerifiedByUserId" = \?\s+ORDER BY id FOR NO KEY UPDATE/,
      );
      expect(valuesAt(4)).toEqual(['u1']);
      // Главы и аудиоглавы комментариев — `KEY SHARE` после версий: удаление главы держит её
      // строку, и удаление пользователя встаёт за ним раньше первого комментария.
      expect(sqlAt(1)).toMatch(/'chapter', "chapterId" FROM "Comment" WHERE "userId" = \?/);
      expect(sqlAt(1)).toMatch(/'audio', "audioChapterId" FROM "Comment" WHERE "userId" = \?/);
      expect(sqlAt(5)).toContain(
        'SELECT id FROM "Chapter" WHERE id = ANY(?::text[]) ORDER BY id FOR KEY SHARE',
      );
      expect(valuesAt(5)).toEqual([['ch2', 'ch1']]);
      expect(sqlAt(6)).toContain(
        'SELECT id FROM "AudioChapter" WHERE id = ANY(?::text[]) ORDER BY id FOR KEY SHARE',
      );
      expect(valuesAt(6)).toEqual([['au1']]);
      // Свои комментарии и чужие прямые ответы на них — одной выборкой, корни раньше ответов,
      // под замком до лайков: порядок `CommentsService.remove` и каскада главы.
      expect(sqlAt(7)).toMatch(
        /WHERE "userId" = \?\s+OR "parentId" IN \(SELECT id FROM "Comment" WHERE "userId" = \?\)\s+ORDER BY \("parentId" IS NOT NULL\), id FOR UPDATE/,
      );
      expect(valuesAt(7)).toEqual(['u1', 'u1']);
      const lastLockAt = txQueryRaw.mock.invocationCallOrder[7];
      for (const write of [
        prismaMock.like.deleteMany,
        prismaMock.bookshelf.deleteMany,
        prismaMock.readingProgress.deleteMany,
        prismaMock.viewStat.updateMany,
      ]) {
        expect(lastLockAt).toBeLessThan(write.mock.invocationCallOrder[0]);
      }
    });

    it('deleteById: контента нет — замков книг и версий нет (пустой IN не собирается)', async () => {
      txQueryRaw
        .mockResolvedValueOnce([{ id: 'u1' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.deleteById('u1', 'admin-1');

      // Замок пользователя, чтение целей и замок комментариев автора; книг и версий нет.
      expect(txQueryRaw).toHaveBeenCalledTimes(3);
    });

    it.each(writers)('$name: строки под замком нет — 404 без записей и журнала', async (w) => {
      txQueryRaw.mockResolvedValueOnce([]);

      await expect(w.call()).rejects.toThrow(new NotFoundException('User not found'));
      for (const op of w.writes()) expect(op).not.toHaveBeenCalled();
    });

    /**
     * `LEGACY-425`: снимок половин имени до замка не видит встречную правку другой половины.
     * Посадка ловит именно это — читает `firstName`/`lastName` клиентом транзакции **после**
     * замка, а не корневым клиентом до неё.
     */
    it('update: name собирается из половин, прочитанных клиентом транзакции после замка', async () => {
      const txFindUniqueOrThrow = jest.fn().mockResolvedValue({ firstName: 'X', lastName: 'B' });
      const txUpdate = jest.fn().mockResolvedValue(baseUser);
      prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        return arg({
          ...prismaMock,
          $queryRaw: txQueryRaw,
          user: { ...prismaMock.user, findUniqueOrThrow: txFindUniqueOrThrow, update: txUpdate },
        });
      });

      await service.update('u1', { lastName: 'B' }, 'admin-1');

      // Никакого чтения половин имени вне транзакции — старый снимок до замка не берётся вовсе.
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
      const lockAt = txQueryRaw.mock.invocationCallOrder[0];
      const readAt = txFindUniqueOrThrow.mock.invocationCallOrder[0];
      expect(readAt).toBeGreaterThan(lockAt);
      expect(txFindUniqueOrThrow).toHaveBeenCalledTimes(1);
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(txUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'X B' }) }),
      );
    });

    it.each([
      [{ firstName: null }, 'B'],
      [{ lastName: null }, 'X'],
      [{ firstName: null, lastName: null }, null],
    ])('update %j: null очищает половину, name без неё — %p', async (dto, name) => {
      prismaMock.user.findUniqueOrThrow.mockResolvedValue({ firstName: 'X', lastName: 'B' });

      await service.update(
        'u1',
        dto as unknown as Parameters<UsersService['update']>[1],
        'admin-1',
      );

      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.update.mock.calls[0][0].data).toEqual({ ...dto, name });
    });

    it('update без половин имени их не читает и name не трогает', async () => {
      await service.update('u1', { roles: ['admin'] }, 'admin-1');

      expect(prismaMock.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.update.mock.calls[0][0].data).not.toHaveProperty('name');
    });

    it('update с паролем на несуществующего пользователя: 404 без хеша и транзакции', async () => {
      const hash = argon2.hash as jest.Mock;
      hash.mockClear();
      prismaMock.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.update('nope', { password: 'secret-password' }, 'admin-1'),
      ).rejects.toThrow(new NotFoundException('User not found'));
      expect(hash).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
  });

  /**
   * ⚠️ Параметры транзакции — тоже поведение, а не украшение: на дефолтных
   * `timeout: 5000 / maxWait: 2000` смена набора ролей на занятом пуле отдаёт `P2028` и 500.
   * Без этой проверки снятие второго аргумента `$transaction` не роняет ничего.
   */
  it('все пять путей: транзакция идёт с явными timeout и maxWait', async () => {
    const expected = { timeout: 30_000, maxWait: 10_000 };
    // Читается именно первый вызов: перед каждой проверкой стоит `mockClear()`, поэтому
    // вызов в мокe ровно один. Имя говорит «первый», чтобы помощник не начал врать, когда
    // на каком-то пути появится вторая транзакция.
    const optionsOfFirstTransaction = () => prismaMock.$transaction.mock.calls[0][1];

    prismaMock.user.findUniqueOrThrow.mockResolvedValue({ firstName: null, lastName: null });
    prismaMock.user.update.mockResolvedValue(baseUser);
    prismaMock.userRole.findMany.mockResolvedValue([]);

    await service.update('u1', { firstName: 'Jane' }, 'admin-1');
    expect(optionsOfFirstTransaction()).toEqual(expected);

    prismaMock.$transaction.mockClear();
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({ ...baseUser, roles: [] });

    await service.create(
      { email: 'new@example.com', password: 'secret-password', roles: [RoleName.user] },
      'admin-1',
    );
    expect(optionsOfFirstTransaction()).toEqual(expected);

    // ⚠️ Две ручки `/roles/:role` проверяются здесь же, а не «по аналогии»: параметры
    // транзакции — поведение, и снятие их с любого из четырёх путей обязано краснеть.
    prismaMock.$transaction.mockClear();
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
    prismaMock.userRole.createMany.mockResolvedValue({ count: 1 });

    await service.assignRole('u1', 'admin', 'admin-1');
    expect(optionsOfFirstTransaction()).toEqual(expected);

    prismaMock.$transaction.mockClear();
    prismaMock.userRole.delete = jest.fn().mockResolvedValue({});

    await service.revokeRole('u1', 'admin', 'admin-1');
    expect(optionsOfFirstTransaction()).toEqual(expected);

    // Пятый путь (`LEGACY-015`): удаление пользователя. Цепочка здесь длиннее всех
    // остальных — комментарии, лайки, полки, прогресс, роли и две записи журнала, —
    // и именно на ней дефолт Prisma отказывает первым.
    prismaMock.$transaction.mockClear();
    prismaMock.user.findUnique.mockResolvedValue(baseUser);
    prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.userRole.findMany.mockResolvedValue([]);
    prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.user.delete.mockResolvedValue(baseUser);

    await service.deleteById('u1', 'admin-1');
    expect(optionsOfFirstTransaction()).toEqual(expected);
  });

  /**
   * Первый администратор заводится именно здесь. Без посадки его происхождение
   * по журналу восстановить было бы нечем.
   */
  it('create: роли начального набора пишутся как выдача', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      ...baseUser,
      roles: [{ role: { name: 'admin' } }, { role: { name: 'user' } }],
    });
    prismaMock.userRole.findMany.mockResolvedValue([]);

    await service.create(
      { email: 'new@example.com', password: 'secret-password', roles: [RoleName.admin] },
      'admin-1',
    );

    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(2);
    expect(adminAudit.record).toHaveBeenNthCalledWith(1, expect.anything(), {
      actorUserId: 'admin-1',
      action: 'ROLE_ASSIGNED',
      targetType: 'USER',
      targetId: 'u1',
      payload: { role: 'admin' },
    });
    expect(adminAudit.record).toHaveBeenNthCalledWith(2, expect.anything(), {
      actorUserId: 'admin-1',
      action: 'ROLE_ASSIGNED',
      targetType: 'USER',
      targetId: 'u1',
      payload: { role: 'user' },
    });
  });

  /**
   * Та же посадка на четвёртом и последнем пути записи. Четыре пути — четыре теста
   * на тождество клиента: подмену ловит только тот, что стоит на этом методе.
   */
  it('create: создание пользователя и запись журнала идут одной транзакцией', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.userRole.findMany.mockResolvedValue([]);
    const txCreate = jest.fn().mockResolvedValue({
      ...baseUser,
      roles: [{ role: { name: 'admin' } }],
    });
    let txClient: unknown;
    prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
      if (typeof arg !== 'function') return Promise.all(arg);
      txClient = {
        ...prismaMock,
        user: { ...prismaMock.user, create: txCreate },
      };
      return arg(txClient as PrismaStub);
    });

    await service.create(
      { email: 'new@example.com', password: 'secret-password', roles: [RoleName.admin] },
      'admin-1',
    );

    expect(txCreate).toHaveBeenCalled();
    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record).toHaveBeenCalledWith(txClient, {
      actorUserId: 'admin-1',
      action: AdminAuditAction.ROLE_ASSIGNED,
      targetType: AdminAuditTargetType.USER,
      targetId: 'u1',
      payload: { role: 'admin' },
    });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.adminAuditEvent.createMany).not.toHaveBeenCalled();
  });

  it('revokeRole: cannot revoke base user role', async () => {
    await expect(service.revokeRole('u1', 'user', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('assignRole: user or role not found', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.assignRole('missing', 'admin', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.role.findUnique.mockResolvedValueOnce(null);
    await expect(service.assignRole('u1', 'admin', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('revokeRole: пользователя или роли нет — 404 обеими проверками', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.revokeRole('missing', 'admin', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.role.findUnique.mockResolvedValueOnce(null);
    await expect(service.revokeRole('u1', 'admin', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * `LEGACY-194`. Пользователь и роль существуют, а связи между ними нет:
   * `delete` доходил до базы, Prisma бросала `P2025`, и наружу это уходило
   * как 500 — то есть штатная ситуация «роли и так не было» выглядела
   * падением сервера и заводила алерт в Sentry.
   *
   * ⚠️ Отказ ставится настоящим `Prisma.PrismaClientKnownRequestError`, а не
   * объектом с полем `code`. Проверка в сервисе идёт через `instanceof`, и
   * подделка прошла бы мимо неё: тест был бы зелёным на несработавшей ветке.
   */
  it('revokeRole: связи нет — 404, а не 500', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: 'admin' });
    prismaMock.userRole.delete.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
        code: 'P2025',
        clientVersion: '7.0.0',
      }),
    );

    await expect(service.revokeRole('u1', 'admin', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * Обратная половина той же ветки, и без неё первая проходит на `catch`,
   * который глотает всё подряд: настоящий сбой базы обязан остаться 5xx,
   * иначе он не долетит до Sentry — фильтр репортит только 5xx.
   */
  it('revokeRole: любой другой отказ базы пробрасывается как есть', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: 'admin' });
    const failure = new Prisma.PrismaClientKnownRequestError('Timed out fetching a connection.', {
      code: 'P2024',
      clientVersion: '7.0.0',
    });
    prismaMock.userRole.delete.mockRejectedValueOnce(failure);

    await expect(service.revokeRole('u1', 'admin', 'admin-1')).rejects.toBe(failure);
  });

  /** Отказ не-`Error` объектом тоже не должен превращаться в 404. */
  it('revokeRole: отказ без кода Prisma не маскируется под 404', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(baseUser);
    prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: 'admin' });
    prismaMock.userRole.delete.mockRejectedValueOnce({ code: 'P2025' });

    await expect(service.revokeRole('u1', 'admin', 'admin-1')).rejects.not.toBeInstanceOf(
      NotFoundException,
    );
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
      prismaMock.user.findUnique.mockResolvedValue(baseUser);
      prismaMock.user.findUniqueOrThrow.mockResolvedValue({
        firstName: baseUser.firstName,
        lastName: baseUser.lastName,
      });
      prismaMock.role.findUnique.mockResolvedValue({
        id: 'r1',
        name: 'admin' as RoleName,
      });
      prismaMock.userRole.createMany.mockResolvedValue({ count: 1 });
      prismaMock.userRole.delete = jest.fn().mockResolvedValue({});
    });

    afterAll(() => rolesCache.clear());

    it('assignRole', async () => {
      seed('u1');
      await service.assignRole('u1', 'admin', 'admin-1');
      expect(cached('u1')).toBeUndefined();
    });

    it('assignRole сбрасывает только названного — соседи в кэше остаются', async () => {
      seed('u1');
      seed('сосед');
      await service.assignRole('u1', 'admin', 'admin-1');
      // `clear()` вместо `invalidate(userId)` отправил бы в базу всех вошедших.
      expect(cached('сосед')).toEqual(new Set([Role.Admin]));
    });

    it('revokeRole', async () => {
      seed('u1');
      await service.revokeRole('u1', 'admin', 'admin-1');
      expect(cached('u1')).toBeUndefined();
    });

    it('deleteById', async () => {
      seed('u1');
      prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.userRole.findMany.mockResolvedValueOnce([]);
      prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.user.delete.mockResolvedValue(baseUser);

      await service.deleteById('u1', 'admin-1');
      expect(cached('u1')).toBeUndefined();
    });

    it('update с новым набором ролей', async () => {
      seed('u1');
      prismaMock.role.findMany = jest.fn().mockResolvedValue([{ id: 'r1', name: 'admin' }]);
      prismaMock.userRole.createMany = jest.fn().mockResolvedValue({ count: 1 });
      prismaMock.userRole.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.user.update.mockResolvedValue(baseUser);
      prismaMock.userRole.findMany.mockResolvedValue([]);

      await service.update('u1', { roles: ['admin'] }, 'actor-1');
      expect(cached('u1')).toBeUndefined();
    });

    it('update без ролей кэш не трогает — сброс не веерный', async () => {
      seed('u1');
      prismaMock.user.update.mockResolvedValue(baseUser);
      prismaMock.userRole.findMany.mockResolvedValue([]);

      await service.update('u1', { firstName: 'Jane' }, 'actor-1');
      expect(cached('u1')).toEqual(new Set([Role.Admin]));
    });
  });

  /**
   * 🔴 `LEGACY-451`, `LEGACY-452`. Смена пароля, блокировка и смена ролей обязаны гасить все
   * выданные токены: `tokenVersion++` в базе и сброс `sessionStateCache` на этом экземпляре.
   * Без инкремента старый access и refresh живут до своего срока; без сброса кэша — ещё
   * до `ROLES_CACHE_TTL_MS` после записи.
   */
  describe('версия сессий (LEGACY-451, LEGACY-452)', () => {
    const INCREMENT = { increment: 1 };
    const seedSession = (userId: string): void => {
      sessionStateCache.set(
        userId,
        { isActive: true, tokenVersion: 0 },
        Date.now() + 60_000,
        Date.now(),
        sessionStateCache.beginRead(),
      );
    };
    const sessionCached = (userId: string) => sessionStateCache.get(userId, Date.now());
    /** `data` единственной записи строки `User` в `update`. */
    const updateData = (): Record<string, unknown> => {
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
      return prismaMock.user.update.mock.calls[0][0].data as Record<string, unknown>;
    };

    beforeEach(() => {
      sessionStateCache.clear();
      prismaMock.user.findUniqueOrThrow.mockResolvedValue({ firstName: null, lastName: null });
      prismaMock.user.findUnique.mockResolvedValue(baseUser);
      prismaMock.user.update.mockResolvedValue(baseUser);
      prismaMock.userRole.findMany.mockResolvedValue([]);
      prismaMock.role.findUnique.mockResolvedValue({ id: 'r1', name: 'admin' as RoleName });
      prismaMock.userRole.createMany = jest.fn().mockResolvedValue({ count: 1 });
      prismaMock.userRole.delete = jest.fn().mockResolvedValue({});
    });

    afterAll(() => sessionStateCache.clear());

    it('update с паролем: версия растёт, кэш сессии сброшен', async () => {
      seedSession('u1');
      (argon2.hash as jest.Mock).mockResolvedValueOnce('new-hash');
      await service.update('u1', { password: 'secret12' }, 'actor-1');
      expect(updateData().tokenVersion).toEqual(INCREMENT);
      expect(sessionCached('u1')).toBeUndefined();
    });

    it('update isActive=false: версия растёт, кэш сессии сброшен', async () => {
      seedSession('u1');
      await service.update('u1', { isActive: false }, 'actor-1');
      expect(updateData()).toEqual(
        expect.objectContaining({ isActive: false, tokenVersion: INCREMENT }),
      );
      expect(sessionCached('u1')).toBeUndefined();
    });

    it('update isActive=true: версию не трогает, но кэш сброшен — разблокировка видна сразу', async () => {
      seedSession('u1');
      await service.update('u1', { isActive: true }, 'actor-1');
      expect(updateData()).not.toHaveProperty('tokenVersion');
      expect(sessionCached('u1')).toBeUndefined();
    });

    it('update с другим набором ролей: версия растёт той же записью строки', async () => {
      seedSession('u1');
      prismaMock.role.findMany = jest.fn().mockResolvedValue([{ id: 'r1', name: 'admin' }]);
      prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
      await service.update('u1', { roles: ['admin'] }, 'actor-1');
      expect(updateData().tokenVersion).toEqual(INCREMENT);
      expect(sessionCached('u1')).toBeUndefined();
    });

    it('update тем же набором ролей: версия не растёт', async () => {
      prismaMock.role.findMany = jest.fn().mockResolvedValue([{ id: 'r1', name: 'admin' }]);
      prismaMock.userRole.findMany.mockResolvedValue([{ role: { name: 'admin' } }]);
      prismaMock.userRole.deleteMany.mockResolvedValue({ count: 1 });
      await service.update('u1', { roles: ['admin'] }, 'actor-1');
      expect(updateData()).not.toHaveProperty('tokenVersion');
    });

    it('update профиля без пароля, ролей и блокировки: версия и кэш сессии не тронуты', async () => {
      seedSession('u1');
      await service.update('u1', { firstName: 'Jane' }, 'actor-1');
      expect(updateData()).not.toHaveProperty('tokenVersion');
      expect(sessionCached('u1')).toBeDefined();
    });

    it('assignRole: версия растёт в той же транзакции, кэш сессии сброшен', async () => {
      seedSession('u1');
      await service.assignRole('u1', 'admin', 'admin-1');
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { tokenVersion: INCREMENT },
        select: { id: true },
      });
      expect(sessionCached('u1')).toBeUndefined();
    });

    it('deleteById: кэш сессии удалённого сброшен сразу', async () => {
      seedSession('u1');
      prismaMock.like.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.bookshelf.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.readingProgress.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.viewStat.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.userRole.findMany.mockResolvedValueOnce([]);
      prismaMock.userRole.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.user.delete.mockResolvedValue(baseUser);

      await service.deleteById('u1', 'admin-1');
      expect(sessionCached('u1')).toBeUndefined();
    });

    it.each([
      ['assignRole', (svc: UsersService) => svc.assignRole('u1', 'admin', 'admin-1')],
      ['revokeRole', (svc: UsersService) => svc.revokeRole('u1', 'admin', 'admin-1')],
    ])('%s: версия растёт клиентом транзакции, а не корневым', async (_name, act) => {
      const txUserUpdate = jest.fn().mockResolvedValue({ id: 'u1' });
      prismaMock.$transaction.mockImplementationOnce(async (arg: TransactionArg) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        return arg({
          ...prismaMock,
          user: { ...prismaMock.user, update: txUserUpdate },
        } as PrismaStub);
      });

      await act(service);

      expect(txUserUpdate).toHaveBeenCalledTimes(1);
      expect(txUserUpdate).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { tokenVersion: INCREMENT },
        select: { id: true },
      });
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('assignRole уже имеющейся роли: версия не растёт', async () => {
      prismaMock.userRole.createMany = jest.fn().mockResolvedValue({ count: 0 });
      await service.assignRole('u1', 'admin', 'admin-1');
      expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('revokeRole: версия растёт, кэш сессии сброшен', async () => {
      seedSession('u1');
      await service.revokeRole('u1', 'admin', 'admin-1');
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { tokenVersion: INCREMENT },
        select: { id: true },
      });
      expect(sessionCached('u1')).toBeUndefined();
    });
  });

  it('list: pagination boundaries and staff=exclude filter', async () => {
    const uA = { ...baseUser, id: 'uA', email: 'admin@example.com' } as User;
    const uB = { ...baseUser, id: 'uB', email: 'plain@example.com' } as User;
    prismaMock.user.count.mockResolvedValue(2);
    prismaMock.user.findMany.mockResolvedValue([uA, uB]);
    prismaMock.userRole.findMany.mockResolvedValue([]);

    const res = await service.list({ page: 1, limit: 1, staff: 'exclude' });
    // Тело обёртки сверяется целиком (`LEGACY-177`): выпавшее или лишнее поле
    // пагинации поштучные `toBe` пропускали бы.
    expect(res.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
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
    prismaMock.user.count.mockResolvedValue(1);
    prismaMock.user.findMany.mockResolvedValue([uA]);
    // Список считает роли пакетно (`LEGACY-125`), поэтому строка связи несёт
    // `userId`: по нему роль и раскладывается по пользователям.
    prismaMock.userRole.findMany.mockResolvedValue([{ userId: 'uA', role: { name: 'admin' } }]);

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
      prismaMock.user.count.mockResolvedValue(tenUsers.length);
      prismaMock.user.findMany.mockResolvedValue(tenUsers);
    });

    it('на 10 пользователях userRole.findMany зовётся ровно один раз', async () => {
      prismaMock.userRole.findMany.mockResolvedValue([]);

      await service.list({ page: 1, limit: 10 });

      expect(prismaMock.userRole.findMany).toHaveBeenCalledTimes(1);
      const [args] = prismaMock.userRole.findMany.mock.calls[0];
      expect(args.where).toEqual({ userId: { in: tenUsers.map((u) => u.id) } });
    });

    it('роль из UserRole достаётся своему пользователю, а не всем подряд', async () => {
      prismaMock.userRole.findMany.mockResolvedValue([
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
      prismaMock.userRole.findMany.mockResolvedValue([]);

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
      prismaMock.userRole.findMany.mockResolvedValue([]);

      await service.list({ page: 1, limit: 10 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(tenUsers.map((u) => u.id));
      spy.mockRestore();
    });

    it('на пустой странице в базу за ролями не ходит вовсе', async () => {
      prismaMock.user.count.mockResolvedValue(0);
      prismaMock.user.findMany.mockResolvedValue([]);

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
      prismaMock.userRole.findMany.mockResolvedValue([]);

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
      prismaMock.comment.count.mockResolvedValueOnce(1);
      const res = await service.getActivities('u1');
      expect(res.items.length).toBe(1);
      expect(res.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
        hasNext: false,
      });
      expect(res.items[0].text).toBe('hello');
      expect(res.items[0].bookVersion).toEqual({
        id: 'v1',
        title: 'Book Title',
        author: 'Author Name',
        coverImageUrl: 'cover.jpg',
        slug: 'book-slug',
      });
      expect(res.items[0].replies.length).toBe(1);
      expect(res.items[0].replies[0].text).toBe('reply');
    });

    // Посадка LEGACY-218: потолок строк. Вторая страница режется `take`,
    // `hasNext` считается от `total`, а не от длины текущего куска.
    it('режет страницу по limit и считает hasNext (LEGACY-218)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      prismaMock.comment.count.mockResolvedValueOnce(25);

      const res = await service.getActivities('u1', 2, 10);

      expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        skip: number;
        take: number;
      };
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      // `hasNext` остался, но переехал внутрь `pagination` (`LEGACY-177`):
      // сверка идёт телом целиком, а не по одному полю.
      expect(res.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNext: true,
      });
    });

    it('hasNext ложно на последней странице (LEGACY-218)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      prismaMock.comment.count.mockResolvedValueOnce(20);

      const res = await service.getActivities('u1', 2, 10);

      expect(res.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 20,
        totalPages: 2,
        hasNext: false,
      });
    });

    // 🔴 Главная половина LEGACY-218: текст главы не читается вовсе. Проверяется
    // ФОРМА запроса, а не ответа: `include` вместо `select` вернул бы `Chapter`
    // целиком вместе с колонкой `content` (полный текст главы) на каждый
    // комментарий к главе — ровно то, ради чего запись заводилась, — а по моку
    // ответа этого не видно. Точное равенство: `include` рядом с `select`
    // Prisma не принимает, но подмена `select` на `include` без него пройдёт.
    it('у главы и аудиоглавы читает только bookVersion, а не тело главы (LEGACY-218)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      await service.getActivities('u1');

      expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      };

      // Верхний уровень выборки — белый список, а не `include`: иначе на каждую
      // страницу поедут все скаляры `Comment`, включая будущие колонки.
      expect(args.include).toBeUndefined();
      expect(args.select).toBeDefined();

      // Ровно `bookVersion` и ничего больше: ни `content`, ни прочих полей главы.
      const bookVersionOnly = {
        select: {
          bookVersion: {
            select: {
              id: true,
              title: true,
              author: true,
              coverImageUrl: true,
              book: { select: { slug: true } },
            },
          },
        },
      };
      expect(args.select?.chapter).toEqual(bookVersionOnly);
      expect(args.select?.audioChapter).toEqual(bookVersionOnly);
    });

    // Посадка находки ревью: `createdAt` не уникален, и без второго ключа
    // страницы под `skip`/`take` разъезжаются — запись приезжает дважды либо
    // не приезжает вовсе (`LEGACY-128`).
    it('сортирует со вторым ключом, иначе страницы разъезжаются (LEGACY-218)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      await service.getActivities('u1');

      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };

      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
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

      expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        select: {
          parent: { select: { user: { select: Record<string, unknown> } } };
          children: { select: { user: { select: Record<string, unknown> } } };
        };
      };

      expect(args.select.parent.select.user.select).toEqual(PUBLIC_COMMENT_USER_SELECT);
      expect(args.select.children.select.user.select).toEqual(PUBLIC_COMMENT_USER_SELECT);
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

      expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        select: { children: { where: Record<string, unknown> } };
      };

      // `LEGACY-366`: свои скрытые ответы выбираются, чужие скрытые — нет.
      expect(args.select.children.where).toEqual({
        isDeleted: false,
        OR: [{ isHidden: false }, { userId: 'u1' }],
      });
    });

    // Вторая половина той же записи: скрытый и удалённый родитель отсеиваются
    // `where` самого запроса, а не JS-фильтром после выборки — иначе появление
    // `skip`/`take` (`LEGACY-218`) укоротило бы страницы и оставило бы пустой
    // хвост при непустом остатке (предупреждение было записано в комментарии
    // самого метода до этой правки). Проверяются аргументы запроса: ответ
    // собирается из мока и о фильтрации в базе ничего не знает — живой прогон
    // на настоящей связи «к одному» — `test/personal-data-leaks.e2e-spec.ts`,
    // describe `LEGACY-210`.
    it('фильтрует скрытого/удалённого родителя в where, а не в памяти (LEGACY-210)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      await service.getActivities('u1');

      expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };

      expect(args.where).toEqual({
        userId: 'u1',
        isDeleted: false,
        OR: [{ parentId: null }, { parent: { is: { isDeleted: false, isHidden: false } } }],
      });
    });

    // Посадка LEGACY-212. Три утверждения, и они закрывают разные половины решения
    // арбитра от 04.09.2026 (вариант B).
    //
    // 🔴 Первое — про `where`: `isHidden: false` туда добавлять НЕЛЬЗЯ. Соблазн
    // сделать «как с isDeleted» велик, поэтому равенство точное: запись автора,
    // скрытая модератором, обязана остаться в его активности, иначе модерация
    // неотличима от пропажи данных.
    it('не убирает собственную скрытую запись из выборки (LEGACY-212)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      await service.getActivities('u1');

      expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prismaMock.comment.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };

      expect(args.where).toEqual({
        userId: 'u1',
        isDeleted: false,
        OR: [{ parentId: null }, { parent: { is: { isDeleted: false, isHidden: false } } }],
      });
    });

    // Второе и третье — про форму ответа: признак скрытия уходит наружу, а ветка
    // ответов третьих лиц под скрытым корнем — нет. Публично скрытый корень прячет
    // всю ветку, и отдавать её автору значило бы повторить LEGACY-210 зеркально.
    // Поправка арбитра от 04.09.2026: под скрытым корнем остаются СВОИ ответы
    // автора, уходят только чужие. Ни один другой тест этот вход не подаёт —
    // всюду ветка состоит из чужих ответов, и подмена фильтра на пустой массив
    // прошла бы незамеченной.
    it('под скрытым корнем оставляет свой ответ и убирает чужой (LEGACY-212)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([
        {
          id: 'c1',
          text: 'mine',
          isHidden: true,
          createdAt: new Date(),
          parentId: null,
          parent: null,
          bookVersion: null,
          chapter: null,
          audioChapter: null,
          children: [
            { id: 'own', text: 'my reply', createdAt: new Date(), user: { id: 'u1' } },
            { id: 'foreign', text: 'their reply', createdAt: new Date(), user: { id: 'u2' } },
          ],
        },
      ]);

      const res = await service.getActivities('u1');

      expect(res.items[0].replies.map((r) => r.id)).toEqual(['own']);
    });

    // Посадка LEGACY-366 (решение арбитра 16.09.2026, вариант A). Выборка теперь
    // отдаёт и свои скрытые ответы, поэтому маппер решает, где они видны.
    describe('скрытые собственные ответы (LEGACY-366)', () => {
      const row = (id: string, isHidden: boolean, children: unknown[]) => ({
        id,
        text: 'root',
        isHidden,
        createdAt: new Date(),
        parentId: null,
        parent: null,
        bookVersion: null,
        chapter: null,
        audioChapter: null,
        children,
      });
      const reply = (id: string, userId: string, isHidden: boolean) => ({
        id,
        text: id,
        isHidden,
        createdAt: new Date(),
        user: { id: userId },
      });

      it('под скрытым корнем свой скрытый ответ приходит в replies с признаком', async () => {
        prismaMock.comment.findMany.mockResolvedValueOnce([
          row('R', true, [reply('Q', 'u1', true), reply('own', 'u1', false)]),
        ]);

        const res = await service.getActivities('u1');

        expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
        expect(res.items[0].replies.map((r) => [r.id, r.isHidden])).toEqual([
          ['Q', true],
          ['own', false],
        ]);
      });

      // Под видимым корнем свой скрытый ответ уже приходит отдельным элементом
      // (`whereBase` его пропускает), в ветке он был бы дублем.
      it('под видимым корнем свой скрытый ответ приходит только отдельным элементом', async () => {
        prismaMock.comment.findMany.mockResolvedValueOnce([
          row('Q', true, []),
          row('R', false, [reply('Q', 'u1', true), reply('ok', 'u2', false)]),
        ]);

        const res = await service.getActivities('u1');

        expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
        const ids = res.items.flatMap((item) => [item.id, ...item.replies.map((r) => r.id)]);
        expect(ids.filter((id) => id === 'Q')).toHaveLength(1);
        expect(res.items[1].replies.map((r) => [r.id, r.isHidden])).toEqual([['ok', false]]);
      });

      // Выборка чужие скрытые не отдаёт, но маппер не должен на это полагаться:
      // вход подаётся напрямую.
      it('чужой скрытый ответ не приходит ни под каким корнем', async () => {
        prismaMock.comment.findMany.mockResolvedValueOnce([
          row('R1', false, [reply('F1', 'u2', true)]),
          row('R2', true, [reply('F2', 'u2', true)]),
        ]);

        const res = await service.getActivities('u1');

        expect(prismaMock.comment.findMany).toHaveBeenCalledTimes(1);
        expect(res.items.map((item) => item.replies)).toEqual([[], []]);
      });
    });

    it('у скрытой записи отдаёт флаг, а чужие ответы убирает (LEGACY-212)', async () => {
      const base = {
        text: 'mine',
        createdAt: new Date(),
        parentId: null,
        parent: null,
        bookVersion: null,
        chapter: null,
        audioChapter: null,
        children: [
          { id: 'r1', text: 'reply', createdAt: new Date(), user: { id: 'u2', nickname: 'nick' } },
        ],
      };
      prismaMock.comment.findMany.mockResolvedValueOnce([
        { ...base, id: 'c1', isHidden: true },
        { ...base, id: 'c2', isHidden: false },
      ]);

      const res = await service.getActivities('u1');

      expect(res.items.map((r) => r.id)).toEqual(['c1', 'c2']);
      expect(res.items[0].isHidden).toBe(true);
      expect(res.items[0].replies).toEqual([]);
    });

    it('у обычной записи флаг false, а replies на месте (LEGACY-212)', async () => {
      prismaMock.comment.findMany.mockResolvedValueOnce([
        {
          id: 'c1',
          text: 'mine',
          isHidden: false,
          createdAt: new Date(),
          parentId: null,
          parent: null,
          bookVersion: null,
          chapter: null,
          audioChapter: null,
          children: [
            {
              id: 'r1',
              text: 'reply',
              createdAt: new Date(),
              user: { id: 'u2', nickname: 'nick' },
            },
          ],
        },
      ]);

      const res = await service.getActivities('u1');

      expect(res.items[0].isHidden).toBe(false);
      expect(res.items[0].replies.map((r) => r.id)).toEqual(['r1']);
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

      const [select] = selectsOf(prismaMock.user.findUnique);
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
      prismaMock.user.count.mockResolvedValueOnce(1);
      prismaMock.user.findMany.mockResolvedValueOnce([baseUser]);
      prismaMock.userRole.findMany.mockResolvedValue([]);
      await service.list({ page: 1, limit: 10 });

      const [select] = selectsOf(prismaMock.user.findMany);
      expect(select).toEqual(ACCOUNT_USER_SELECT);
      expect(select).not.toHaveProperty('passwordHash');
    });

    it('list: ни в одном элементе ответа нет ключа passwordHash', async () => {
      prismaMock.user.count.mockResolvedValueOnce(1);
      prismaMock.user.findMany.mockResolvedValueOnce([baseUser]);
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

      const [select] = selectsOf(prismaMock.user.findUnique);
      expect(select).toEqual({ id: true });
    });

    // 🔴 Отдельно от чтений: `create`, `update` и `delete` возвращают строку
    // пользователя точно так же, как `findUnique`, и без `select` отдают хеш.
    // Без этих спек возврат `include`/безусловной записи проходит незамеченным.
    it('create: запись зовётся с select без passwordHash', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce(null);
      prismaMock.user.create.mockResolvedValueOnce({
        ...baseUser,
        roles: [{ role: { name: 'user' } }],
      });

      await service.create(
        {
          email: 'new@example.com',
          password: 'secret-password',
          roles: [RoleName.user],
        },
        'actor-1',
      );

      const [select] = selectsOf(prismaMock.user.create);
      expect(select).not.toHaveProperty('passwordHash');
      expect(select).toMatchObject(ACCOUNT_USER_SELECT);
      // Проверка занятости почты читает только идентификатор.
      expect(selectsOf(prismaMock.user.findUnique)[0]).toEqual({ id: true });
    });

    it('update: чтение половин имени и запись сужены, passwordHash не читается', async () => {
      prismaMock.user.findUniqueOrThrow.mockResolvedValueOnce({
        firstName: 'John',
        lastName: null,
      });
      prismaMock.user.update.mockResolvedValueOnce(baseUser);
      prismaMock.userRole.findMany.mockResolvedValue([]);

      // `lastName` меняется — половины перечитываются клиентом транзакции (`LEGACY-425`).
      // Тест смотрит не на тело, а на `select` обоих обращений к базе: чтение берёт две
      // половины имени без `passwordHash`, запись — белый список аккаунта.
      await service.update('u1', { lastName: 'Doe' }, 'actor-1');

      const [readSelect] = selectsOf(prismaMock.user.findUniqueOrThrow);
      expect(readSelect).not.toHaveProperty('passwordHash');
      expect(Object.keys(readSelect).sort()).toEqual(['firstName', 'lastName']);

      const [writeSelect] = selectsOf(prismaMock.user.update);
      expect(writeSelect).toEqual(ACCOUNT_USER_SELECT);
    });

    it('deleteById: удаление зовётся с select без passwordHash', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      prismaMock.comment.findMany.mockResolvedValueOnce([]);
      prismaMock.userRole.findMany.mockResolvedValueOnce([]);
      prismaMock.user.delete.mockResolvedValueOnce(baseUser);

      await service.deleteById('u1', 'admin-1');

      const [deleteSelect] = selectsOf(prismaMock.user.delete);
      expect(deleteSelect).toEqual(ACCOUNT_USER_SELECT);
      expect(selectsOf(prismaMock.user.findUnique)[0]).toEqual({ id: true });
    });

    it('ни одна операция над пользователем не идёт без select', async () => {
      prismaMock.user.findFirst.mockResolvedValueOnce(null);
      prismaMock.user.update.mockResolvedValueOnce(baseUser);
      await service.updateMe('u1', { nickname: 'free_nick' });

      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: RoleName.admin });
      prismaMock.userRole.createMany.mockResolvedValueOnce({ count: 1 });
      await service.assignRole('u1', RoleName.admin, 'admin-1');

      prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'u1' });
      prismaMock.role.findUnique.mockResolvedValueOnce({ id: 'r1', name: RoleName.admin });
      await service.revokeRole('u1', RoleName.admin, 'admin-1');

      const calls = [
        ...prismaMock.user.findUnique.mock.calls,
        ...prismaMock.user.findFirst.mock.calls,
        ...prismaMock.user.update.mock.calls,
      ];
      expect(calls.length).toBeGreaterThan(0);
      for (const [args] of calls) {
        expect(args).toHaveProperty('select');
        expect(args.select).not.toHaveProperty('passwordHash');
      }
    });
  });
});
