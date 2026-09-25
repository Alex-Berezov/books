import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

    /**
     * `LEGACY-398`, второе место. Голый `catch {}` раньше принимал за гонку
     * по уникальному индексу любую ошибку базы и отвечал 400 «Unable to like»,
     * пряча причину. Ловится должен только `P2002` — остальное пробрасывается.
     */
    it('пробрасывает не-P2002 отказ create, а не отвечает "Unable to like"', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const dbDown = new Prisma.PrismaClientKnownRequestError('connection reset', {
        code: 'P1001',
        clientVersion: 'test',
      });
      prisma.like.create.mockRejectedValueOnce(dbDown);
      await expect(service.like('u1', { commentId: 'c1' })).rejects.toBe(dbDown);
      expect(prisma.like.findFirst).toHaveBeenCalledTimes(1);
    });

    /**
     * `LEGACY-398`. Гонка по уникальному индексу: `create` бьёт в `P2002`,
     * повторный `findFirst` находит строку соперника — ответ не 500.
     */
    it('на P2002 перечитывает строку соперника вместо 500', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.like.create.mockRejectedValueOnce(p2002);
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'rival', isLike: false });
      prisma.like.update.mockResolvedValueOnce({ id: 'rival', isLike: true });
      const res = await service.like('u1', { commentId: 'c1', isLike: true });
      expect(res).toEqual({ id: 'rival', isLike: true });
    });
  });

  describe('like() — гонки (LEGACY-398)', () => {
    it('цель удалена между проверкой и записью — P2003 читается как 404', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2003', clientVersion: 'test' }),
      );
      await expect(service.like('u1', { commentId: 'c1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('ветка перечитки сбрасывает кэш счётчика, как и обычная запись', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }),
      );
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'rival', isLike: false });
      prisma.like.update.mockResolvedValueOnce({ id: 'rival', isLike: true });
      await service.like('u1', { commentId: 'c1', isLike: true });
      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith('likes:count:comment:c1');
    });

    it('строка соперника исчезла до update — P2025 читается как 409', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }),
      );
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'rival', isLike: false });
      prisma.like.update.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }),
      );
      await expect(service.like('u1', { commentId: 'c1', isLike: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('like()/unlike() — встречные запросы (LEGACY-398)', () => {
    const p = (code: string) =>
      new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

    it('like(): перечитка после P2002 не нашла строку — 409, а не 400', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(p('P2002'));
      prisma.like.findFirst.mockResolvedValueOnce(null);
      await expect(service.like('u1', { commentId: 'c1' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('like(): смена реакции, строку снял встречный unlike — 409, а не 500', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1', isLike: true });
      prisma.like.update.mockRejectedValueOnce(p('P2025'));
      await expect(service.like('u1', { commentId: 'c1', isLike: false })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unlike(): строку уже снял встречный unlike — успех, а не 500', async () => {
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1' });
      prisma.like.delete.mockRejectedValueOnce(p('P2025'));
      await expect(service.unlike('u1', { commentId: 'c1' })).resolves.toEqual({ success: true });
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

    /**
     * `LEGACY-398`. Два одновременных `toggle` без предыдущей реакции оба
     * видят пустой `findFirst`, и второй `create` бьёт в уникальный индекс.
     * Раньше это не ловилось вовсе — 500 вместо ответа.
     */
    it('на P2002 перечитывает строку соперника и решает delete/update, а не 500', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', {
        code: 'P2002',
        clientVersion: 'test',
      });
      prisma.like.create.mockRejectedValueOnce(p2002);
      // Соперник уже поставил ту же реакцию — toggle отвечает "снял".
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'rival', isLike: true });
      cache.get.mockResolvedValueOnce(undefined);
      prisma.like.count.mockResolvedValueOnce(1);
      prisma.like.count.mockResolvedValueOnce(0);

      const res = await service.toggle('u1', { commentId: 'c1', isLike: true });

      expect(prisma.like.delete).toHaveBeenCalledTimes(1);
      expect(prisma.like.delete).toHaveBeenCalledWith({ where: { id: 'rival' } });
      expect(res.liked).toBe(false);
    });

    it('на P2002, если строка соперника уже исчезла, отвечает 409, а не сырым P2002', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.like.findFirst.mockResolvedValueOnce(null);

      await expect(service.toggle('u1', { commentId: 'c1', isLike: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('пробрасывает не-P2002 отказ create в toggle тоже', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      const dbDown = new Prisma.PrismaClientKnownRequestError('connection reset', {
        code: 'P1001',
        clientVersion: 'test',
      });
      prisma.like.create.mockRejectedValueOnce(dbDown);
      await expect(service.toggle('u1', { commentId: 'c1', isLike: true })).rejects.toBe(dbDown);
    });

    it('две встречные отмены одной реакции — P2025 у второй читается как 409, а не 500', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'l1', isLike: true });
      prisma.like.delete.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }),
      );
      await expect(service.toggle('u1', { commentId: 'c1', isLike: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('после перечитки строка соперника исчезла до delete — 409, а не 500', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1' });
      prisma.like.findFirst.mockResolvedValueOnce(null);
      prisma.like.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }),
      );
      prisma.like.findFirst.mockResolvedValueOnce({ id: 'rival', isLike: true });
      prisma.like.delete.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }),
      );
      await expect(service.toggle('u1', { commentId: 'c1', isLike: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
