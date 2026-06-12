import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LikesService } from './likes.service';
import { CacheService } from '../../shared/cache/cache.interface';
import { LikeRequestDto } from './dto/like.dto';

interface PrismaStub {
  comment: { findUnique: jest.Mock };
  bookVersion: { findUnique: jest.Mock };
  like: {
    findFirst: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  comment: { findUnique: jest.fn() },
  bookVersion: { findUnique: jest.fn() },
  like: {
    findFirst: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
});

const createCacheStub = () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
});

describe('LikesService', () => {
  let service: LikesService;
  let prisma: PrismaStub;
  let cache: ReturnType<typeof createCacheStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    cache = createCacheStub();
    service = new LikesService(
      prisma as unknown as PrismaService,
      cache as unknown as CacheService,
    );
  });

  describe('like()', () => {
    it('validates exactly one target', async () => {
      const empty = {} as unknown as LikeRequestDto;
      await expect(service.like('u1', empty)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.like('u1', { commentId: 'c', bookVersionId: 'v' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound when targets missing', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(service.like('u1', { commentId: 'c1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
      await expect(service.like('u1', { bookVersionId: 'v1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('is idempotent: Conflict when already reacted in the same way', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1', isLike: true });
      await expect(service.like('u1', { commentId: 'c1', isLike: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('updates reaction if type changes (like to dislike)', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1', isLike: true });
      prisma.like.update.mockResolvedValueOnce({ id: 'l1', isLike: false });
      const res = await service.like('u1', { commentId: 'c1', isLike: false });
      expect(res.isLike).toBe(false);
      expect(prisma.like.update).toHaveBeenCalled();
    });

    it('creates like and invalidates cache', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const created = { id: 'l1', isLike: true };
      prisma.like.create.mockResolvedValueOnce(created);
      const res = await service.like('u1', { commentId: 'c1' });
      expect(res).toEqual(created);
      expect(cache.del).toHaveBeenCalledWith('likes:count:comment:c1');
    });
  });

  describe('unlike()', () => {
    it('is idempotent when not liked', async () => {
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const res = await service.unlike('u1', { commentId: 'c1' });
      expect(res).toEqual({ success: true });
      expect(prisma.like.delete).not.toHaveBeenCalled();
    });

    it('deletes existing like and invalidates cache', async () => {
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1' });
      const res = await service.unlike('u1', { bookVersionId: 'v1' });
      expect(res).toEqual({ success: true });
      expect(prisma.like.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
      expect(cache.del).toHaveBeenCalledWith('likes:count:bookVersion:v1');
    });
  });

  describe('count()', () => {
    it('returns cached value if present', async () => {
      const cachedRes = { likes: 3, dislikes: 1, count: 3 };
      cache.get.mockResolvedValueOnce(cachedRes);
      const res = await service.count({ target: 'comment', targetId: 'c1' });
      expect(res).toEqual(cachedRes);
      expect(prisma.like.count).not.toHaveBeenCalled();
    });

    it('counts and caches when missing', async () => {
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(5); // likes count
      prisma.like.count.mockResolvedValueOnce(2); // dislikes count
      const res = await service.count({ target: 'comment', targetId: 'c1' });
      expect(res).toEqual({ likes: 5, dislikes: 2, count: 5 });
    });
  });

  describe('toggle()', () => {
    it('toggles like state and returns updated count', async () => {
      // existing same reaction => delete
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1', isLike: true });
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(0); // likes
      prisma.like.count.mockResolvedValueOnce(0); // dislikes
      const res1 = await service.toggle('u1', { commentId: 'c1', isLike: true });
      expect(res1).toEqual({ liked: false, isLike: true, likes: 0, dislikes: 0, count: 0 });

      // switch type => update
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1', isLike: true });
      prisma.like.update.mockResolvedValueOnce({ id: 'l1', isLike: false });
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(0); // likes
      prisma.like.count.mockResolvedValueOnce(1); // dislikes
      const res2 = await service.toggle('u1', { commentId: 'c1', isLike: false });
      expect(res2).toEqual({ liked: true, isLike: false, likes: 0, dislikes: 1, count: 0 });
    });
  });
});
