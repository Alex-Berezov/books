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
    count: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  comment: { findUnique: jest.fn() },
  bookVersion: { findUnique: jest.fn() },
  like: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn(), count: jest.fn() },
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

    it('is idempotent: Conflict when already liked', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1' });
      await expect(service.like('u1', { commentId: 'c1' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('creates like and invalidates cache', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const created = { id: 'l1' };
      prisma.like.create.mockResolvedValueOnce(created);
      const res = await service.like('u1', { commentId: 'c1' });
      expect(res).toEqual(created);
      expect(cache.del).toHaveBeenCalledWith('likes:count:comment:c1');
    });

    it('race fallback: Conflict if created by another concurrently', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(new Error('unique violation'));
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1' });
      await expect(service.like('u1', { commentId: 'c1' })).rejects.toBeInstanceOf(
        ConflictException,
      );
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
      cache.get.mockResolvedValueOnce(3);
      const res = await service.count({ target: 'comment', targetId: 'c1' });
      expect(res).toEqual({ count: 3 });
      expect(prisma.like.count).not.toHaveBeenCalled();
    });

    it('counts and caches when missing', async () => {
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(5);
      const res = await service.count({ target: 'bookVersion', targetId: 'v1' });
      expect(res).toEqual({ count: 5 });
      expect(cache.set).toHaveBeenCalledWith('likes:count:bookVersion:v1', 5, 5000);
    });
  });

  describe('toggle()', () => {
    it('toggles like state and returns updated count', async () => {
      // existing like => delete
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1' });
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(0);
      const res1 = await service.toggle('u1', { commentId: 'c1' });
      expect(res1).toEqual({ liked: false, count: 0 });
      expect(cache.del).toHaveBeenCalledWith('likes:count:comment:c1');

      // not existing => create
      prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: 'v1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(1);
      const res2 = await service.toggle('u1', { bookVersionId: 'v1' });
      expect(res2).toEqual({ liked: true, count: 1 });
      expect(cache.del).toHaveBeenCalledWith('likes:count:bookVersion:v1');
    });

    it('validates targets exist before toggling', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(service.toggle('u1', { commentId: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
      await expect(service.toggle('u1', { bookVersionId: 'v' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
