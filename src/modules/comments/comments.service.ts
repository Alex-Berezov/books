/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

@Injectable()
export class CommentsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async list(params: {
    target: 'version' | 'chapter' | 'audio';
    targetId: string;
    page: number;
    limit: number;
    includeHidden?: boolean;
  }) {
    const { target, targetId, page, limit, includeHidden } = params;
    const whereBase: Prisma.CommentWhereInput = {
      isDeleted: false,
      ...(includeHidden ? {} : { isHidden: false }),
      ...(target === 'version' ? { bookVersionId: targetId } : {}),
      ...(target === 'chapter' ? { chapterId: targetId } : {}),
      ...(target === 'audio' ? { audioChapterId: targetId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where: whereBase,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { children: true, user: { select: { id: true, email: true, name: true } } },
      }),
      this.prisma.comment.count({ where: whereBase }),
    ]);
    return { items, total, page, limit, hasNext: page * limit < total };
  }

  async create(userId: string, dto: CreateCommentDto) {
    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent || (parent as any).isDeleted) {
        throw new NotFoundException('Parent comment not found');
      }
    }

    if (dto.bookVersionId) {
      const exist = await this.prisma.bookVersion.findUnique({ where: { id: dto.bookVersionId } });
      if (!exist) throw new NotFoundException('BookVersion not found');
    }
    if (dto.chapterId) {
      const exist = await this.prisma.chapter.findUnique({ where: { id: dto.chapterId } });
      if (!exist) throw new NotFoundException('Chapter not found');
    }
    if (dto.audioChapterId) {
      const exist = await this.prisma.audioChapter.findUnique({
        where: { id: dto.audioChapterId },
      });
      if (!exist) throw new NotFoundException('AudioChapter not found');
    }

    return this.prisma.comment.create({
      data: {
        userId,
        bookVersionId: dto.bookVersionId,
        chapterId: dto.chapterId,
        audioChapterId: dto.audioChapterId,
        parentId: dto.parentId,
        text: dto.text,
      },
    });
  }

  async get(id: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id } });
    if (!comment || (comment as any).isDeleted) {
      throw new NotFoundException('Comment not found');
    }
    return comment;
  }

  async update(id: string, actor: { userId: string; email: string }, dto: UpdateCommentDto) {
    const existing = await this.prisma.comment.findUnique({ where: { id } });
    if (!existing || (existing as any).isDeleted) throw new NotFoundException('Comment not found');

    const canModerate = await this.isModerator(actor.email, actor.userId);
    const data: any = {};
    if (dto.text !== undefined) {
      if (existing.userId !== actor.userId && !canModerate)
        throw new ForbiddenException('Not allowed to edit this comment');
      data.text = dto.text;
    }
    if (dto.isHidden !== undefined) {
      if (!canModerate) throw new ForbiddenException('Not allowed to moderate');
      data.isHidden = dto.isHidden;
    }
    if (Object.keys(data).length === 0) return existing;
    return this.prisma.comment.update({ where: { id }, data });
  }

  private async isModerator(email: string, userId: string): Promise<boolean> {
    const dbRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    const roleSet = new Set(dbRoles.map((r) => r.role.name));
    const admins = (this.config.get<string>('ADMIN_EMAILS') || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const managers = (this.config.get<string>('CONTENT_MANAGER_EMAILS') || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (admins.includes(email.toLowerCase())) roleSet.add('admin');
    if (managers.includes(email.toLowerCase())) roleSet.add('content_manager');
    return roleSet.has('admin') || roleSet.has('content_manager');
  }

  async moderate(id: string, isHidden: boolean, actor: { userId: string; email: string }) {
    return this.update(id, actor, { isHidden });
  }

  async remove(id: string, actor: { userId: string; email: string }) {
    const existing = await this.prisma.comment.findUnique({ where: { id } });
    if (!existing || (existing as any).isDeleted) return; // idempotent
    if (existing.userId !== actor.userId) {
      const can = await this.isModerator(actor.email, actor.userId);
      if (!can) throw new ForbiddenException('Not allowed to delete this comment');
    }
    await this.prisma.comment.update({ where: { id }, data: { isDeleted: true } });
  }
}
