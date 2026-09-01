import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Language as PrismaLanguage, RoleName, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { STAFF_ROLE_NAMES } from './users.constants';
import { ACCOUNT_USER_SELECT, AccountUser } from '../../common/selects/account-user.select';
import { PUBLIC_COMMENT_USER_SELECT } from '../../common/selects/public-comment-user.select';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { rolesCache } from '../../common/roles/roles-cache';

/**
 * Prisma сообщает кодом `P2025`, что строки под запись не нашлось (`LEGACY-194`).
 *
 * ⚠️ Проверка через `instanceof`, а не через каст `as Prisma.PrismaClientKnownRequestError`.
 * Каст утверждает тип, которого у пойманного значения может не быть: отклонить
 * промис можно чем угодно, и на строке или на голом объекте чтение `.code`
 * молча даст `undefined`, а сравнение — `false`. Тогда «нет такой связи»
 * снова уедет наружу как 500, и тест на возврат дефекта этого не покажет.
 */
const isRecordNotFound = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';

/**
 * Проверка существования пользователя читает одно поле (`LEGACY-116`).
 *
 * ⚠️ `ACCOUNT_USER_SELECT` здесь не нужен: методу важно только, есть запись или
 * нет, а лишние поля — это лишние данные в памяти без единого потребителя.
 */
const USER_EXISTS_SELECT = { id: true } satisfies Prisma.UserSelect;

type PublicUser = AccountUser;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private moderatorRoles: ModeratorRolesService,
  ) {}

  async me(userId: string): Promise<PublicUser & { roles: RoleName[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: ACCOUNT_USER_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    const roles = await this.computeRoles(user);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      nickname: user.nickname,
      isActive: user.isActive,
      avatarUrl: user.avatarUrl,
      languagePreference: user.languagePreference,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      roles,
    };
  }

  async getById(userId: string): Promise<PublicUser> {
    return this.me(userId);
  }

  async updateMe(
    userId: string,
    data: {
      name?: string;
      nickname?: string;
      avatarUrl?: string;
      languagePreference?: PrismaLanguage;
    },
  ): Promise<PublicUser> {
    if (data.nickname) {
      const existing = await this.prisma.user.findFirst({
        where: {
          nickname: { equals: data.nickname, mode: 'insensitive' },
          id: { not: userId },
        },
        select: USER_EXISTS_SELECT,
      });
      if (existing) {
        throw new ConflictException('Nickname is already in use');
      }
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: ACCOUNT_USER_SELECT,
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      nickname: user.nickname,
      isActive: user.isActive,
      avatarUrl: user.avatarUrl,
      languagePreference: user.languagePreference,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  async deleteById(userId: string): Promise<PublicUser> {
    const userBefore = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_EXISTS_SELECT,
    });
    if (!userBefore) throw new NotFoundException('User not found');

    const deleted = await this.prisma.$transaction(async (tx) => {
      // 1) Collect user's comment IDs
      const userComments = await tx.comment.findMany({
        where: { userId },
        select: { id: true },
      });
      const commentIds = userComments.map((c) => c.id);

      // 2) Remove likes written by the user
      await tx.like.deleteMany({ where: { userId } });

      // 3) Remove likes that target comments authored by the user
      if (commentIds.length > 0) {
        await tx.like.deleteMany({ where: { commentId: { in: commentIds } } });
        // 4) Detach children of user's comments to avoid FK on parentId
        await tx.comment.updateMany({
          where: { parentId: { in: commentIds } },
          data: { parentId: null },
        });
        // 5) Delete user's comments
        await tx.comment.deleteMany({ where: { id: { in: commentIds } } });
      }

      // 6) Bookshelf and reading progress
      await tx.bookshelf.deleteMany({ where: { userId } });
      await tx.readingProgress.deleteMany({ where: { userId } });

      // 7) View stats: nullify userId (optional FK)
      await tx.viewStat.updateMany({ where: { userId }, data: { userId: null } });

      // 8) Media assets: nullify createdById
      await tx.mediaAsset.updateMany({
        where: { createdById: userId },
        data: { createdById: null },
      });

      // 9) Role links
      await tx.userRole.deleteMany({ where: { userId } });

      // 10) Finally delete the user
      return tx.user.delete({ where: { id: userId }, select: ACCOUNT_USER_SELECT });
    });
    rolesCache.invalidate(userId);

    return {
      id: deleted.id,
      email: deleted.email,
      name: deleted.name,
      firstName: deleted.firstName,
      lastName: deleted.lastName,
      nickname: deleted.nickname,
      isActive: deleted.isActive,
      avatarUrl: deleted.avatarUrl,
      languagePreference: deleted.languagePreference,
      createdAt: deleted.createdAt,
      lastLogin: deleted.lastLogin,
    };
  }

  async listRoles(userId: string): Promise<RoleName[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_EXISTS_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    return roles.map((ur) => ur.role.name);
  }

  async assignRole(
    userId: string,
    roleName: RoleName,
  ): Promise<{ userId: string; role: RoleName }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_EXISTS_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new NotFoundException('Role not found');
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id },
      update: {},
    });
    rolesCache.invalidate(userId);
    return { userId, role: role.name };
  }

  async revokeRole(
    userId: string,
    roleName: RoleName,
  ): Promise<{ userId: string; role: RoleName }> {
    if (roleName === 'user') throw new BadRequestException('Cannot revoke base user role');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_EXISTS_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new NotFoundException('Role not found');
    try {
      await this.prisma.userRole.delete({ where: { userId_roleId: { userId, roleId: role.id } } });
    } catch (error) {
      // `P2025` — «нечего удалять»: роли у пользователя нет. Ответ 404, как
      // у двух проверок выше, а не 500 (`LEGACY-194`). Идемпотентности здесь
      // быть не должно: 200 стёр бы разницу между «роль сняли» и «роли не
      // было», и повторный отзыв выглядел бы удачным.
      if (isRecordNotFound(error)) {
        throw new NotFoundException('Role is not assigned to user');
      }
      // Любой другой отказ базы — настоящий сбой, и он обязан остаться 5xx:
      // `SentryExceptionFilter` шлёт в Sentry только их.
      throw error;
    }
    rolesCache.invalidate(userId);
    return { userId, role: role.name };
  }

  /**
   * ⚠️ Аргумент сужен до двух полей намеренно (`LEGACY-116`): полный `User` в
   * сигнатуре требовал бы читать пользователя целиком ради `id` и `email`.
   */
  private async computeRoles(user: { id: string; email: string }): Promise<RoleName[]> {
    // Роли считает `ModeratorRolesService` (`LEGACY-111`) и берёт их только из
    // `UserRole` (`LEGACY-170`). Здесь остаётся неявная базовая `user`: её
    // выдача — свойство этой ручки, а не общей проверки.
    const set = await this.moderatorRoles.rolesOf({ userId: user.id, email: user.email });
    return this.withBaseRole(set);
  }

  /**
   * Роли для набора пользователей — одним запросом (`LEGACY-125`).
   *
   * Базовая `user` добавляется тем же `withBaseRole`, что и в одиночном
   * `computeRoles`: два пути обязаны отдавать один и тот же состав ролей.
   */
  private async computeRolesForMany(userIds: string[]): Promise<Map<string, RoleName[]>> {
    const sets = await this.moderatorRoles.rolesOfMany(userIds);
    const map = new Map<string, RoleName[]>();
    for (const [userId, set] of sets) map.set(userId, this.withBaseRole(set));
    return map;
  }

  /** Неявная базовая `user` — свойство выдачи этой ручки, а не общей проверки. */
  private withBaseRole(set: Set<RoleName>): RoleName[] {
    set.add('user');
    return Array.from(set);
  }

  async list(params: {
    page: number;
    limit: number;
    q?: string;
    staff?: 'only' | 'exclude';
  }): Promise<{
    items: (PublicUser & { roles: RoleName[] })[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, q, staff } = params;

    // Base search filter
    const baseWhere: Prisma.UserWhereInput = q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {};

    // Staff filter
    //
    // 🔴 Сотрудник определяется строками `UserRole`, и только ими. Раньше сюда
    // подмешивались почты из `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS`, и
    // список сотрудников расходился с тем, что решает `RolesGuard`
    // (`LEGACY-170`). Вернуть окружение в этот фильтр - значит снова показать
    // в админке сотрудником того, кого гвард на маршрут не пустит.

    // Prisma where building
    let where: Prisma.UserWhereInput = baseWhere;
    if (staff === 'only') {
      where = {
        AND: [
          baseWhere,
          {
            roles: {
              some: {
                role: { name: { in: [...STAFF_ROLE_NAMES] as RoleName[] } },
              },
            },
          },
        ],
      };
    } else if (staff === 'exclude') {
      where = {
        AND: [
          baseWhere,
          {
            NOT: {
              roles: {
                some: {
                  role: { name: { in: [...STAFF_ROLE_NAMES] as RoleName[] } },
                },
              },
            },
          },
        ],
      };
    }

    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: ACCOUNT_USER_SELECT,
      }),
    ]);

    const rolesByUser = await this.computeRolesForMany(users.map((u) => u.id));

    const items = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      firstName: u.firstName,
      lastName: u.lastName,
      nickname: u.nickname,
      isActive: u.isActive,
      avatarUrl: u.avatarUrl,
      languagePreference: u.languagePreference,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      roles: rolesByUser.get(u.id) ?? this.withBaseRole(new Set()),
    }));

    return { items, total, page, limit };
  }

  async create(dto: CreateUserDto): Promise<PublicUser & { roles: RoleName[] }> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: USER_EXISTS_SELECT,
    });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        name: [dto.firstName, dto.lastName].filter(Boolean).join(' ') || undefined,
        isActive: dto.isActive ?? true,
        languagePreference: PrismaLanguage.en, // Default
        roles: {
          // `lawyer` (Phase 19) is unknown to the generated client until the VPS regenerates it,
          // so the assignable-role literal is cast rather than typed through `RoleName`.
          create: (dto.roles || [RoleName.user]).map((role) => ({
            role: { connect: { name: role as RoleName } },
          })),
        },
      },
      select: { ...ACCOUNT_USER_SELECT, roles: { select: { role: { select: { name: true } } } } },
    });

    const roles = user.roles.map((ur) => ur.role.name);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      nickname: user.nickname,
      isActive: user.isActive,
      avatarUrl: user.avatarUrl,
      languagePreference: user.languagePreference,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      roles,
    };
  }

  async update(id: string, dto: UpdateUserDto): Promise<PublicUser & { roles: RoleName[] }> {
    // Читаются ровно те поля, из которых ниже собирается `name`.
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const { password, roles: rolesDto, ...rest } = dto;
    const data: Prisma.UserUpdateInput = {
      ...rest,
    };

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const newFirstName = dto.firstName ?? user.firstName;
      const newLastName = dto.lastName ?? user.lastName;
      data.name = [newFirstName, newLastName].filter(Boolean).join(' ') || null;
    }

    if (password) {
      data.passwordHash = await argon2.hash(password);
    }

    const updatedUser = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data, select: ACCOUNT_USER_SELECT });

      if (rolesDto) {
        const desired = Array.from(new Set(rolesDto));
        const dbRoles = await tx.role.findMany({
          where: { name: { in: desired as RoleName[] } },
        });
        if (dbRoles.length !== desired.length) {
          throw new NotFoundException('One or more roles not found');
        }
        // Replace role set: remove all, then create desired
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: dbRoles.map((r) => ({ userId: id, roleId: r.id })),
          skipDuplicates: true,
        });
      }

      return u;
    });
    if (rolesDto) rolesCache.invalidate(id);

    const roles = await this.computeRoles(updatedUser);

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      nickname: updatedUser.nickname,
      isActive: updatedUser.isActive,
      avatarUrl: updatedUser.avatarUrl,
      languagePreference: updatedUser.languagePreference,
      createdAt: updatedUser.createdAt,
      lastLogin: updatedUser.lastLogin,
      roles,
    };
  }

  async getActivities(userId: string) {
    const comments = await this.prisma.comment.findMany({
      where: { userId, isDeleted: false },
      include: {
        parent: {
          include: {
            user: { select: PUBLIC_COMMENT_USER_SELECT },
          },
        },
        // 🔴 Владелец страницы активности модератором не является: ветка ему
        // положена в том же виде, что анониму в публичной ветке. До 15.08.2026
        // здесь стоял только `isDeleted`, и скрытый модератором ответ приезжал
        // сюда целиком — с текстом и с личностью написавшего (`LEGACY-210`).
        // Образец — `commentChildren` в модуле комментариев, но переносить её
        // сюда нельзя: она завязана на `canModerate`, которого у этого маршрута
        // нет вовсе.
        children: {
          where: { isDeleted: false, isHidden: false },
          include: {
            user: { select: PUBLIC_COMMENT_USER_SELECT },
          },
        },
        bookVersion: {
          select: {
            id: true,
            title: true,
            author: true,
            coverImageUrl: true,
            book: { select: { slug: true } },
          },
        },
        chapter: {
          include: {
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
        },
        audioChapter: {
          include: {
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
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Скрытый модератором родитель приравнивается к удалённому: запись
    // активности уходит из ответа целиком, как уже уходила при `isDeleted`
    // (`LEGACY-210`). Оба признака проверяются в одном месте и маппер не
    // трогается, поэтому форма ответа не меняется — из выдачи пропадают
    // элементы, полей не убавляется.
    //
    // ⚠️ Отсев именно здесь — не потому, что база так не умеет: `where` внутри
    // `include` связь «к одному» действительно не принимает, но фильтр по ней
    // ставится на верхнем уровне (`parent: { is: { … } }`). Пока выборка идёт
    // без `take`/`skip`, разницы нет. Появится пагинация — фильтр обязан
    // переехать в запрос, иначе страницы поедут короче `limit`, а последняя
    // окажется пустой при непустом остатке.
    const activeComments = comments.filter(
      (c) => !c.parent || (!c.parent.isDeleted && !c.parent.isHidden),
    );

    return activeComments.map((comment) => {
      let bookVersion = comment.bookVersion;
      if (!bookVersion && comment.chapter?.bookVersion) {
        bookVersion = comment.chapter.bookVersion;
      }
      if (!bookVersion && comment.audioChapter?.bookVersion) {
        bookVersion = comment.audioChapter.bookVersion;
      }

      return {
        id: comment.id,
        text: comment.text,
        createdAt: comment.createdAt,
        parentId: comment.parentId,
        bookVersion: bookVersion
          ? {
              id: bookVersion.id,
              title: bookVersion.title,
              author: bookVersion.author,
              coverImageUrl: bookVersion.coverImageUrl,
              slug: bookVersion.book.slug,
            }
          : null,
        parent: comment.parent
          ? {
              id: comment.parent.id,
              text: comment.parent.text,
              createdAt: comment.parent.createdAt,
              user: comment.parent.user,
            }
          : null,
        replies: comment.children.map((child) => ({
          id: child.id,
          text: child.text,
          createdAt: child.createdAt,
          user: child.user,
        })),
      };
    });
  }
}
