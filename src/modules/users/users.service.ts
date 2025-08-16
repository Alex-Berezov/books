import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User, Language as PrismaLanguage, RoleName } from '@prisma/client';

type PublicUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
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
    // Clean role links first to satisfy FK constraints
    const userBefore = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!userBefore) throw new NotFoundException('User not found');
    await this.prisma.userRole.deleteMany({ where: { userId } });
    const user = await this.prisma.user.delete({ where: { id: userId } });
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
}
