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
import { LikeCountDto, ToggleLikeResponseDto } from './dto/like-response.dto';
import { msgExactlyOne } from '../../shared/constants/validation';

@Injectable()
export class LikesService {
  constructor(
    private prisma: PrismaService,
    @Inject(CACHE_SERVICE) private cache: CacheService,
  ) {}

  private ensureSingleTarget(dto: { commentId?: string; bookVersionId?: string }) {
    const targets = [dto.commentId, dto.bookVersionId].filter(Boolean);
    if (targets.length !== 1) {
      throw new BadRequestException(msgExactlyOne('commentId', 'bookVersionId'));
    }
  }

  private countCacheKey(target: 'comment' | 'bookVersion', targetId: string) {
    return `likes:count:${target}:${targetId}`;
  }

  async like(userId: string, dto: LikeRequestDto) {
    this.ensureSingleTarget(dto);
    const isLike = dto.isLike !== false;

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

    // idempotent create/update
    const liked = await this.prisma.like.findFirst({
      where: {
        userId,
        commentId: dto.commentId ?? undefined,
        bookVersionId: dto.bookVersionId ?? undefined,
      },
    });

    if (liked) {
      if (liked.isLike === isLike) {
        throw new ConflictException('Already reacted in this way');
      }
      const updated = await this.prisma.like.update({
        where: { id: liked.id },
        data: { isLike },
      });
      if (dto.commentId) await this.cache.del(this.countCacheKey('comment', dto.commentId));
      if (dto.bookVersionId)
        await this.cache.del(this.countCacheKey('bookVersion', dto.bookVersionId));
      return updated;
    }

    try {
      const created = await this.prisma.like.create({
        data: { userId, commentId: dto.commentId, bookVersionId: dto.bookVersionId, isLike },
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
      if (again) {
        if (again.isLike === isLike) throw new ConflictException('Already reacted in this way');
        const updated = await this.prisma.like.update({
          where: { id: again.id },
          data: { isLike },
        });
        return updated;
      }
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

  async count(q: LikeCountQueryDto): Promise<LikeCountDto> {
    const key = this.countCacheKey(q.target, q.targetId);
    const cached = await this.cache.get<LikeCountDto>(key);
    if (cached) return cached;

    if (q.target === 'comment') {
      const [likes, dislikes] = await Promise.all([
        this.prisma.like.count({ where: { commentId: q.targetId, isLike: true } }),
        this.prisma.like.count({ where: { commentId: q.targetId, isLike: false } }),
      ]);
      const res = { likes, dislikes };
      await this.cache.set(key, res, 5_000); // 5s TTL
      return res;
    } else {
      const count = await this.prisma.like.count({
        where: { bookVersionId: q.targetId, isLike: true },
      });
      const res = { likes: count, dislikes: 0 };
      await this.cache.set(key, res, 5_000);
      return res;
    }
  }

  async toggle(userId: string, dto: LikeRequestDto): Promise<ToggleLikeResponseDto> {
    this.ensureSingleTarget(dto);
    const isLike = dto.isLike !== false;

    const target: 'comment' | 'bookVersion' = dto.commentId ? 'comment' : 'bookVersion';
    const targetId = dto.commentId ?? (dto.bookVersionId as string);

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

    const existingLike = await this.prisma.like.findFirst({
      where: {
        userId,
        commentId: dto.commentId ?? undefined,
        bookVersionId: dto.bookVersionId ?? undefined,
      },
    });

    let liked = false;
    if (existingLike) {
      if (existingLike.isLike === isLike) {
        await this.prisma.like.delete({ where: { id: existingLike.id } });
        liked = false;
      } else {
        await this.prisma.like.update({
          where: { id: existingLike.id },
          data: { isLike },
        });
        liked = true;
      }
    } else {
      await this.prisma.like.create({
        data: { userId, commentId: dto.commentId, bookVersionId: dto.bookVersionId, isLike },
      });
      liked = true;
    }

    await this.cache.del(this.countCacheKey(target, targetId));
    const counts = await this.count({ target, targetId });
    return { liked, isLike, ...counts };
  }
}
