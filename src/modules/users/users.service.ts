import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User, Language as PrismaLanguage } from '@prisma/client';

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
}
