import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Like, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_SERVICE, CacheService } from '../../shared/cache/cache.interface';
import { Inject } from '@nestjs/common';
import { LikeRequestDto, LikeCountQueryDto } from './dto/like.dto';
import { LikeCountDto, ToggleLikeResponseDto } from './dto/like-response.dto';
import { msgExactlyOne } from '../../shared/constants/validation';

const isPrismaCode = (e: unknown, code: string): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;

// LEGACY-398: the reader's reaction is still being changed by a parallel request.
const CONCURRENT_REACTION = 'Reaction is being changed concurrently, retry';

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

  private async invalidateCount(dto: LikeRequestDto) {
    if (dto.commentId) await this.cache.del(this.countCacheKey('comment', dto.commentId));
    if (dto.bookVersionId)
      await this.cache.del(this.countCacheKey('bookVersion', dto.bookVersionId));
  }

  private findReaction(userId: string, dto: LikeRequestDto) {
    return this.prisma.like.findFirst({
      where: {
        userId,
        commentId: dto.commentId ?? undefined,
        bookVersionId: dto.bookVersionId ?? undefined,
      },
    });
  }

  /** The row vanishing under a parallel request (P2025) is 409, not 500. */
  private async updateReaction(id: string, isLike: boolean): Promise<Like> {
    try {
      return await this.prisma.like.update({ where: { id }, data: { isLike } });
    } catch (e: unknown) {
      if (isPrismaCode(e, 'P2025')) throw new ConflictException(CONCURRENT_REACTION);
      throw e;
    }
  }

  /** Toggle decision on an existing row; the row vanishing under a parallel request is 409, not 500. */
  private async toggleExisting(row: { id: string; isLike: boolean }, isLike: boolean) {
    try {
      if (row.isLike === isLike) {
        await this.prisma.like.delete({ where: { id: row.id } });
        return false;
      }
      await this.updateReaction(row.id, isLike);
      return true;
    } catch (e: unknown) {
      if (isPrismaCode(e, 'P2025')) throw new ConflictException(CONCURRENT_REACTION);
      throw e;
    }
  }

  async like(userId: string, dto: LikeRequestDto) {
    this.ensureSingleTarget(dto);
    const isLike = dto.isLike !== false;

    if (dto.commentId) {
      const existing = await this.prisma.comment.findUnique({ where: { id: dto.commentId } });
      if (!existing || existing.isDeleted) throw new NotFoundException('Comment not found');
    }
    if (dto.bookVersionId) {
      const existing = await this.prisma.bookVersion.findUnique({
        where: { id: dto.bookVersionId },
      });
      if (!existing) throw new NotFoundException('BookVersion not found');
    }

    // idempotent create/update
    const liked = await this.findReaction(userId, dto);

    if (liked) {
      if (liked.isLike === isLike) {
        throw new ConflictException('Already reacted in this way');
      }
      const updated = await this.updateReaction(liked.id, isLike);
      await this.invalidateCount(dto);
      return updated;
    }

    try {
      const created = await this.prisma.like.create({
        data: { userId, commentId: dto.commentId, bookVersionId: dto.bookVersionId, isLike },
      });
      await this.invalidateCount(dto);
      return created;
    } catch (e: unknown) {
      // The target was checked before, without a lock: deleted in between, it is a 404.
      if (isPrismaCode(e, 'P2003')) throw new NotFoundException('Like target not found');
      // Unique race fallback — only for P2002; any other DB error reaches the client as itself.
      if (!isPrismaCode(e, 'P2002')) throw e;
      const again = await this.findReaction(userId, dto);
      if (!again) throw new ConflictException(CONCURRENT_REACTION);
      if (again.isLike === isLike) throw new ConflictException('Already reacted in this way');
      const updated = await this.updateReaction(again.id, isLike);
      await this.invalidateCount(dto);
      return updated;
    }
  }

  async unlike(userId: string, dto: LikeRequestDto) {
    this.ensureSingleTarget(dto);

    const existing = await this.findReaction(userId, dto);
    if (!existing) return { success: true };

    try {
      await this.prisma.like.delete({ where: { id: existing.id } });
    } catch (e: unknown) {
      // A parallel unlike already removed it: the requested state is reached (LEGACY-398).
      if (!isPrismaCode(e, 'P2025')) throw e;
    }
    await this.invalidateCount(dto);
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
      const res = { likes, dislikes, count: likes };
      await this.cache.set(key, res, 5_000); // 5s TTL
      return res;
    } else {
      const count = await this.prisma.like.count({
        where: { bookVersionId: q.targetId, isLike: true },
      });
      const res = { likes: count, dislikes: 0, count };
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
      if (!existing || existing.isDeleted) throw new NotFoundException('Comment not found');
    }
    if (dto.bookVersionId) {
      const existing = await this.prisma.bookVersion.findUnique({
        where: { id: dto.bookVersionId },
      });
      if (!existing) throw new NotFoundException('BookVersion not found');
    }

    const existingLike = await this.findReaction(userId, dto);

    let liked: boolean;
    if (existingLike) {
      liked = await this.toggleExisting(existingLike, isLike);
    } else {
      try {
        await this.prisma.like.create({
          data: { userId, commentId: dto.commentId, bookVersionId: dto.bookVersionId, isLike },
        });
        liked = true;
      } catch (e: unknown) {
        // Two concurrent toggles with no prior reaction both miss the read above; the
        // loser's create hits the unique index. Re-read and take the same decision.
        if (isPrismaCode(e, 'P2003')) throw new NotFoundException('Like target not found');
        if (!isPrismaCode(e, 'P2002')) throw e;
        const again = await this.findReaction(userId, dto);
        if (!again) throw new ConflictException(CONCURRENT_REACTION);
        liked = await this.toggleExisting(again, isLike);
      }
    }

    await this.cache.del(this.countCacheKey(target, targetId));
    const counts = await this.count({ target, targetId });
    return { liked, isLike, ...counts };
  }
}
