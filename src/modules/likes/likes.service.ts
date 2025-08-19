/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_SERVICE, CacheService } from '../../shared/cache/cache.interface';
import { Inject } from '@nestjs/common';
import { LikeRequestDto, LikeCountQueryDto } from './dto/like.dto';

@Injectable()
export class LikesService {
  constructor(
    private prisma: PrismaService,
    @Inject(CACHE_SERVICE) private cache: CacheService,
  ) {}

  private ensureSingleTarget(dto: { commentId?: string; bookVersionId?: string }) {
    const targets = [dto.commentId, dto.bookVersionId].filter(Boolean);
    if (targets.length !== 1) {
      throw new BadRequestException('Exactly one of commentId or bookVersionId must be provided');
    }
  }

  private countCacheKey(target: 'comment' | 'bookVersion', targetId: string) {
    return `likes:count:${target}:${targetId}`;
  }

  async like(userId: string, dto: LikeRequestDto) {
    this.ensureSingleTarget(dto);

    if (dto.commentId) {
      const existing = await this.prisma.comment.findUnique({ where: { id: dto.commentId } });
      if (!existing || (existing as any).isDeleted)
        throw new NotFoundException('Comment not found');
    }
    if (dto.bookVersionId) {
      const existing = await this.prisma.bookVersion.findUnique({
        where: { id: dto.bookVersionId },
      });
      if (!existing) throw new NotFoundException('BookVersion not found');
    }

    // idempotent create
    const liked = await this.prisma.like.findFirst({
      where: {
        userId,
        commentId: dto.commentId ?? undefined,
        bookVersionId: dto.bookVersionId ?? undefined,
      },
    });
    if (liked) throw new ConflictException('Already liked');

    try {
      const created = await this.prisma.like.create({
        data: { userId, commentId: dto.commentId, bookVersionId: dto.bookVersionId },
      });
      // invalidate cache
      if (dto.commentId) await this.cache.del(this.countCacheKey('comment', dto.commentId));
      if (dto.bookVersionId)
        await this.cache.del(this.countCacheKey('bookVersion', dto.bookVersionId));
      return created;
    } catch {
      // unique race fallback
      const again = await this.prisma.like.findFirst({
        where: {
          userId,
          commentId: dto.commentId ?? undefined,
          bookVersionId: dto.bookVersionId ?? undefined,
        },
      });
      if (again) throw new ConflictException('Already liked');
      throw new BadRequestException('Unable to like');
    }
  }

  async unlike(userId: string, dto: LikeRequestDto) {
    this.ensureSingleTarget(dto);

    const existing = await this.prisma.like.findFirst({
      where: {
        userId,
        commentId: dto.commentId ?? undefined,
        bookVersionId: dto.bookVersionId ?? undefined,
      },
    });
    if (!existing) return { success: true };

    await this.prisma.like.delete({ where: { id: existing.id } });
    // invalidate cache
    if (dto.commentId) await this.cache.del(this.countCacheKey('comment', dto.commentId));
    if (dto.bookVersionId)
      await this.cache.del(this.countCacheKey('bookVersion', dto.bookVersionId));
    return { success: true };
  }

  async count(q: LikeCountQueryDto): Promise<{ count: number }> {
    const key = this.countCacheKey(q.target, q.targetId);
    const cached = await this.cache.get<number>(key);
    if (typeof cached === 'number') return { count: cached };

    const where =
      q.target === 'comment' ? { commentId: q.targetId } : { bookVersionId: q.targetId };
    const count = await this.prisma.like.count({ where });
    await this.cache.set(key, count, 5_000); // 5s TTL in-memory
    return { count };
  }

  async toggle(userId: string, dto: LikeRequestDto): Promise<{ liked: boolean; count: number }> {
    this.ensureSingleTarget(dto);

    const where = {
      userId,
      commentId: dto.commentId ?? undefined,
      bookVersionId: dto.bookVersionId ?? undefined,
    } as const;

    // Ensure targets exist like in like()
    if (dto.commentId) {
      const existing = await this.prisma.comment.findUnique({ where: { id: dto.commentId } });
      if (!existing || (existing as any).isDeleted)
        throw new NotFoundException('Comment not found');
    }
    if (dto.bookVersionId) {
      const existing = await this.prisma.bookVersion.findUnique({
        where: { id: dto.bookVersionId },
      });
      if (!existing) throw new NotFoundException('BookVersion not found');
    }

    const existingLike = await this.prisma.like.findFirst({ where });
    let liked: boolean;
    if (existingLike) {
      await this.prisma.like.delete({ where: { id: existingLike.id } });
      liked = false;
    } else {
      await this.prisma.like.create({
        data: { userId, commentId: dto.commentId, bookVersionId: dto.bookVersionId },
      });
      liked = true;
    }

    const target: 'comment' | 'bookVersion' = dto.commentId ? 'comment' : 'bookVersion';
    const targetId = dto.commentId ?? (dto.bookVersionId as string);
    await this.cache.del(this.countCacheKey(target, targetId));
    const { count } = await this.count({ target, targetId });
    return { liked, count };
  }
}
