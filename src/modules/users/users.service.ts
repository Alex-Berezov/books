import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User, Language as PrismaLanguage, RoleName, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async me(userId: string): Promise<PublicUser & { roles: RoleName[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const roles = await this.computeRoles(user);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
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
    data: { name?: string; avatarUrl?: string; languagePreference?: PrismaLanguage },
  ): Promise<PublicUser> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      languagePreference: user.languagePreference,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  async deleteById(userId: string): Promise<PublicUser> {
    const userBefore = await this.prisma.user.findUnique({ where: { id: userId } });
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
      return tx.user.delete({ where: { id: userId } });
    });

    return {
      id: deleted.id,
      email: deleted.email,
      name: deleted.name,
      avatarUrl: deleted.avatarUrl,
      languagePreference: deleted.languagePreference,
      createdAt: deleted.createdAt,
      lastLogin: deleted.lastLogin,
    };
  }

  async listRoles(userId: string): Promise<RoleName[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new NotFoundException('Role not found');
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id },
      update: {},
    });
    return { userId, role: role.name };
  }

  async revokeRole(
    userId: string,
    roleName: RoleName,
  ): Promise<{ userId: string; role: RoleName }> {
    if (roleName === 'user') throw new BadRequestException('Cannot revoke base user role');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new NotFoundException('Role not found');
    await this.prisma.userRole.delete({ where: { userId_roleId: { userId, roleId: role.id } } });
    return { userId, role: role.name };
  }

  private async computeRoles(user: User): Promise<RoleName[]> {
    // Roles from DB
    const dbLinks = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: true },
    });
    const set = new Set<RoleName>(dbLinks.map((l) => l.role.name));

    // ENV-based elevated roles (same logic as RolesGuard)
    const adminsList = (this.config.get<string>('ADMIN_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const managersList = (this.config.get<string>('CONTENT_MANAGER_EMAILS') || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (adminsList.includes(user.email.toLowerCase())) set.add('admin');
    if (managersList.includes(user.email.toLowerCase())) set.add('content_manager');

    // Baseline 'user'
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
    // We need to consider both DB roles and ENV-based elevation.
    // ENV staff: emails listed in ADMIN_EMAILS or CONTENT_MANAGER_EMAILS
    const adminsList = (this.config.get<string>('ADMIN_EMAILS') || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const managersList = (this.config.get<string>('CONTENT_MANAGER_EMAILS') || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    const envStaffEmails = [...new Set([...adminsList, ...managersList])];
    const envEmailOr: Prisma.UserWhereInput[] = envStaffEmails.map((e) => ({
      email: { equals: e },
    }));

    // Prisma where building
    let where: Prisma.UserWhereInput = baseWhere;
    if (staff === 'only') {
      where = {
        AND: [
          baseWhere,
          {
            OR: [
              // Users with DB roles admin or content_manager
              {
                roles: {
                  some: {
                    role: { name: { in: ['admin', 'content_manager'] as RoleName[] } },
                  },
                },
              },
              // Or users elevated via ENV lists
              ...(envEmailOr.length > 0 ? envEmailOr : []),
            ].filter(Boolean),
          },
        ],
      };
    } else if (staff === 'exclude') {
      where = {
        AND: [
          baseWhere,
          {
            AND: [
              // Not having DB staff roles
              {
                NOT: {
                  roles: {
                    some: {
                      role: { name: { in: ['admin', 'content_manager'] as RoleName[] } },
                    },
                  },
                },
              },
              // And not in ENV staff emails
              ...(envEmailOr.length > 0 ? [{ NOT: { OR: envEmailOr } }] : []),
            ].filter(Boolean),
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
      }),
    ]);

    const items = await Promise.all(
      users.map(async (u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl,
        languagePreference: u.languagePreference,
        createdAt: u.createdAt,
        lastLogin: u.lastLogin,
        roles: await this.computeRoles(u),
      })),
    );

    return { items, total, page, limit };
  }
}
