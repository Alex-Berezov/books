/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';

interface PrismaStub {
  $transaction: jest.Mock<Promise<[any[], number]>, [any[]]>;
  comment: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  userRole: { findMany: jest.Mock };
  bookVersion: { findUnique: jest.Mock };
  chapter: { findUnique: jest.Mock };
  audioChapter: { findUnique: jest.Mock };
}

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return (arg as (tx: any) => Promise<any>)(stub);
      }
      const results: unknown[] = [];
      for (const op of arg) {
        results.push(await op);
      }
      return results as unknown as [any[], number];
    }),
    comment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userRole: { findMany: jest.fn() },
    bookVersion: { findUnique: jest.fn() },
    chapter: { findUnique: jest.fn() },
    audioChapter: { findUnique: jest.fn() },
  };
  return stub;
};

class ConfigStub {
  private store: Record<string, string> = {};
  get(key: string): string | undefined {
    return this.store[key];
  }
  set(key: string, value: string) {
    this.store[key] = value;
  }
}

describe('CommentsService', () => {
  let service: CommentsService;
  let prisma: PrismaStub;
  let config: ConfigStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    config = new ConfigStub();
    service = new CommentsService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('create()', () => {
    it('throws NotFound if parent missing or deleted', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', {
          parentId: 'p1',
          bookVersionId: 'v1',
          text: 'hi',
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'p1', isDeleted: true });
      await expect(
        service.create('u1', {
          parentId: 'p1',
          bookVersionId: 'v1',
          text: 'hi',
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('validates target existence for version/chapter/audio', async () => {
      // version missing
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'p1', isDeleted: false });
      prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', {
          parentId: 'p1',
          bookVersionId: 'v1',
          text: 't',
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);

      // chapter missing
      prisma.comment.findUnique.mockResolvedValueOnce(undefined);
      prisma.chapter.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', { chapterId: 'c1', text: 't' } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);

      // audio missing
      prisma.audioChapter.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', { audioChapterId: 'a1', text: 't' } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates comment when validations pass', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(undefined);
      prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: 'v1' });
      const created = { id: 'c1', text: 'hello' };
      prisma.comment.create.mockResolvedValueOnce(created);
      const res = await service.create('u1', {
        bookVersionId: 'v1',
        text: 'hello',
      } as CreateCommentDto);
      expect(res).toEqual({ ...created, ratingScore: null });
      expect(prisma.comment.create).toHaveBeenCalled();
    });
  });

  describe('get()', () => {
    it('returns comment when exists and not deleted', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false });
      const res = await service.get('c1');
      expect(res).toEqual({ id: 'c1', isDeleted: false, ratingScore: null });
    });

    it('throws NotFound when missing or deleted', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(service.get('x')).rejects.toBeInstanceOf(NotFoundException);
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await expect(service.get('c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update()', () => {
    beforeEach(() => {
      prisma.userRole.findMany.mockResolvedValue([]);
      config.set('ADMIN_EMAILS', '');
      config.set('CONTENT_MANAGER_EMAILS', '');
    });

    it('allows author to edit text', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', userId: 'u1', isDeleted: false });
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', text: 'new' });
      const res = await service.update('c1', { userId: 'u1', email: 'x@y.z' }, { text: 'new' });
      expect(res).toEqual({ id: 'c1', text: 'new', ratingScore: null });
    });

    it('forbids non-author to edit text without moderator rights', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', userId: 'u1', isDeleted: false });
      await expect(
        service.update('c1', { userId: 'u2', email: 'x@y.z' }, { text: 'new' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows moderators (by role) to edit text and hide', async () => {
      prisma.comment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', isDeleted: false });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'content_manager' } }]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', text: 'm', isHidden: true });
      const res = await service.update(
        'c1',
        { userId: 'mod', email: 'm@site.tld' },
        { text: 'm', isHidden: true },
      );
      expect(res).toEqual({ id: 'c1', text: 'm', isHidden: true, ratingScore: null });
    });

    it('allows moderators (by email list) to hide', async () => {
      prisma.comment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', isDeleted: false });
      config.set('ADMIN_EMAILS', 'admin@ex.com');
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isHidden: true });
      const res = await service.update(
        'c1',
        { userId: 'u2', email: 'admin@ex.com' },
        { isHidden: true },
      );
      expect(res).toEqual({ id: 'c1', isHidden: true, ratingScore: null });
    });

    it('returns existing when no changes provided', async () => {
      const existing = { id: 'c1', userId: 'u1', isDeleted: false };
      prisma.comment.findUnique.mockResolvedValueOnce(existing);
      const res = await service.update('c1', { userId: 'u1', email: 'x@y.z' }, {});
      expect(res).toEqual({ id: 'c1', userId: 'u1', isDeleted: false, ratingScore: null });
      expect(prisma.comment.update).not.toHaveBeenCalled();
    });
  });

  describe('moderate()', () => {
    it('delegates to update with isHidden', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', userId: 'u1', isDeleted: false });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'admin' } }]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isHidden: true });
      const res = await service.moderate('c1', true, { userId: 'u2', email: 'x@y.z' });
      expect(res).toEqual({ id: 'c1', isHidden: true, ratingScore: null });
    });
  });

  describe('remove()', () => {
    beforeEach(() => {
      prisma.userRole.findMany.mockResolvedValue([]);
      config.set('ADMIN_EMAILS', '');
      config.set('CONTENT_MANAGER_EMAILS', '');
    });

    it('is idempotent if already deleted or missing', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
    });

    it('forbids non-author non-moderator', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false, userId: 'u1' });
      await expect(service.remove('c1', { userId: 'u2', email: 'x@y.z' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows author', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false, userId: 'u1' });
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await service.remove('c1', { userId: 'u1', email: 'x' });
      expect(prisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isDeleted: true },
      });
    });

    it('allows moderator', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false, userId: 'u1' });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'admin' } }]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await service.remove('c1', { userId: 'mod', email: 'm@x' });
      expect(prisma.comment.update).toHaveBeenCalled();
    });

    it('deletes rating if comment has ratingId', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({
        id: 'c1',
        isDeleted: false,
        userId: 'u1',
        ratingId: 'r1',
      });

      const txMock = {
        comment: {
          update: jest.fn().mockResolvedValueOnce({ id: 'c1', isDeleted: true }),
        },
        bookRating: {
          delete: jest.fn().mockResolvedValueOnce({ id: 'r1' }),
        },
      };

      prisma.$transaction.mockImplementationOnce((arg: any) => {
        return Promise.resolve((arg as (tx: any) => any)(txMock));
      });

      await service.remove('c1', { userId: 'u1', email: 'x' });

      expect(txMock.comment.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isDeleted: true },
      });
      expect(txMock.bookRating.delete).toHaveBeenCalledWith({
        where: { id: 'r1' },
      });
    });
  });

  describe('list()', () => {
    it('applies hidden filter and target mapping with pagination', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([{ id: 'c1' }]);
      prisma.comment.count.mockResolvedValueOnce(2);
      prisma.$transaction.mockImplementationOnce(async (ops: any[]) => {
        const items = (await ops[0]) as any[];
        const total = (await ops[1]) as number;
        return [items, total];
      });
      const res = await service.list({ target: 'version', targetId: 'v1', page: 1, limit: 1 });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isHidden: false,
            isDeleted: false,
            bookVersionId: 'v1',
          }),
          skip: 0,
          take: 1,
        }),
      );
      expect(res).toEqual({
        items: [{ id: 'c1', ratingScore: null }],
        total: 2,
        page: 1,
        limit: 1,
        hasNext: true,
      });

      prisma.comment.findMany.mockClear();
      prisma.comment.findMany.mockResolvedValueOnce([]);
      prisma.comment.count.mockResolvedValueOnce(0);
      prisma.$transaction.mockImplementationOnce(async (ops: any[]) => {
        const items = (await ops[0]) as any[];
        const total = (await ops[1]) as number;
        return [items, total];
      });
      await service.list({
        target: 'chapter',
        targetId: 'ch1',
        page: 1,
        limit: 10,
        includeHidden: true,
      });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isDeleted: false, chapterId: 'ch1' }),
        }),
      );
    });

    it('supports sorting by popularity or date', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([]);
      prisma.comment.count.mockResolvedValueOnce(0);
      prisma.$transaction.mockImplementation(() => {
        return Promise.resolve([[], 0] as [any[], number]);
      });

      await service.list({
        target: 'version',
        targetId: 'v1',
        page: 1,
        limit: 10,
        sortBy: 'popularity',
      });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { likes: { _count: 'desc' } },
        }),
      );

      await service.list({
        target: 'version',
        targetId: 'v1',
        page: 1,
        limit: 10,
        sortBy: 'date',
      });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });

  describe('create() with rating', () => {
    it('creates BookRating and links to comment when rating is provided', async () => {
      const bookVersion = { id: 'v1', bookId: 'b1' };
      prisma.bookVersion.findUnique.mockResolvedValueOnce(bookVersion);

      const ratingMock = { id: 'r1', score: 5 };
      const commentMock = { id: 'c1', text: 'great book', ratingId: 'r1', rating: ratingMock };

      // Mock tx functions
      const txMock = {
        bookRating: {
          upsert: jest.fn().mockResolvedValueOnce(ratingMock),
        },
        comment: {
          create: jest.fn().mockResolvedValueOnce(commentMock),
        },
      };

      prisma.$transaction.mockImplementationOnce((arg: any) => {
        return Promise.resolve((arg as (tx: any) => any)(txMock));
      });

      const res = await service.create('u1', {
        bookVersionId: 'v1',
        text: 'great book',
        rating: 5,
      } as CreateCommentDto);

      expect(txMock.bookRating.upsert).toHaveBeenCalledWith({
        where: { userId_bookId: { userId: 'u1', bookId: 'b1' } },
        create: { userId: 'u1', bookId: 'b1', score: 5 },
        update: { score: 5 },
      });
      expect(res.ratingScore).toBe(5);
    });

    it('throws BadRequestException if rating is provided without bookVersionId', async () => {
      prisma.chapter.findUnique.mockResolvedValueOnce({ id: 'ch1' });
      await expect(
        service.create('u1', {
          chapterId: 'ch1',
          text: 'great book',
          rating: 5,
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
