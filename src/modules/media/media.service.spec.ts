import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaListQueryDto } from './dto/create-media.dto';

describe('MediaService (unit)', () => {
  const prisma = {
    mediaAsset: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    // Ссылки на ассет живут строками URL в четырёх местах (LEGACY-060).
    // По умолчанию — ни одной; конкретный тест подставляет свою.
    bookVersion: { findMany: jest.fn().mockResolvedValue([]) },
    audioChapter: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    authorTranslation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const storage = {
    getPublicUrl: jest.fn<string, any>(),
    delete: jest.fn<Promise<void>, any>(),
  };

  let service: MediaService;

  const noReferences = () => {
    prisma.bookVersion.findMany.mockResolvedValue([]);
    prisma.audioChapter.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.authorTranslation.findMany.mockResolvedValue([]);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    noReferences();
    service = new MediaService(
      prisma as unknown as import('../../prisma/prisma.service').PrismaService,
      storage as unknown as import('../../shared/storage/storage.interface').StorageService,
    );
  });

  describe('confirm', () => {
    it('creates new asset when not exists; uses storage url if not provided', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      const created = { id: '1', key: 'k', url: 'http://u/static/k' };
      prisma.mediaAsset.create.mockResolvedValue(created);
      storage.getPublicUrl.mockReturnValue('http://u/static/k');

      const res = await service.confirm({ key: 'k', url: '' }, 'user-1');
      expect(storage.getPublicUrl).toHaveBeenCalledWith('k');
      // inspect call args explicitly to avoid loose matchers typing issues

      const createArg = prisma.mediaAsset.create.mock.calls[0][0] as {
        data: { key: string; url: string; createdById: string };
      };
      expect(createArg.data.key).toBe('k');
      expect(createArg.data.url).toBe('http://u/static/k');
      expect(createArg.data.createdById).toBe('user-1');
      expect(res).toBe(created);
    });

    it('updates existing asset idempotently and un-deletes it', async () => {
      const existing = { id: 'id-1', key: 'k', url: 'old', isDeleted: true };
      prisma.mediaAsset.findUnique.mockResolvedValue(existing);
      prisma.mediaAsset.update.mockResolvedValue({
        ...existing,
        url: 'http://u/static/k',
        isDeleted: false,
      });
      storage.getPublicUrl.mockReturnValue('http://u/static/k');

      const res = await service.confirm({ key: 'k', url: 'http://u/static/k', size: 10 }, 'user-2');

      const updateArg = prisma.mediaAsset.update.mock.calls[0][0] as {
        where: { id: string };
        data: { url: string; isDeleted: boolean; size?: number };
      };
      expect(updateArg.where.id).toBe('id-1');
      expect(updateArg.data.url).toBe('http://u/static/k');
      expect(updateArg.data.isDeleted).toBe(false);
      expect(updateArg.data.size).toBe(10);
      expect(res.isDeleted).toBe(false);
    });

    it('throws for invalid url (not http)', async () => {
      storage.getPublicUrl.mockReturnValue('http://u/static/k');
      await expect(service.confirm({ key: 'k', url: 'ftp://nope' }, 'u')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('handles unique constraint (P2002) by returning found asset', async () => {
      // Simulate race: create throws P2002, then findUnique returns existing
      const err: any = { code: 'P2002' };
      prisma.mediaAsset.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'x' });
      prisma.mediaAsset.create.mockRejectedValue(err);
      storage.getPublicUrl.mockReturnValue('http://u/static/k');

      const res = await service.confirm({ key: 'k', url: '' }, 'u');
      expect(res).toEqual({ id: 'x' });
    });
  });

  describe('list', () => {
    it('applies defaults and filters by q and type; excludes deleted', async () => {
      prisma.mediaAsset.findMany.mockResolvedValue([{ id: '1' }]);
      prisma.mediaAsset.count.mockResolvedValue(1);

      const res = await service.list({ q: 'covers', type: 'image/' } as MediaListQueryDto);

      const fmArg = prisma.mediaAsset.findMany.mock.calls[0][0] as {
        where: {
          isDeleted: boolean;
          OR: Array<Record<string, unknown>>;
          contentType: { startsWith: string };
        };
        orderBy: { createdAt: 'desc' };
        skip: number;
        take: number;
      };
      expect(fmArg.where.isDeleted).toBe(false);
      expect(fmArg.where.OR).toEqual([
        { key: { contains: 'covers' } },
        { url: { contains: 'covers' } },
      ]);
      expect(fmArg.where.contentType.startsWith).toBe('image/');
      expect(fmArg.orderBy).toEqual({ createdAt: 'desc' });
      expect(fmArg.skip).toBe(0);
      expect(fmArg.take).toBe(20);
      expect(res).toEqual({ items: [{ id: '1' }], total: 1, page: 1, limit: 20 });
    });

    it('supports pagination', async () => {
      prisma.mediaAsset.findMany.mockResolvedValue([{ id: '2' }]);
      prisma.mediaAsset.count.mockResolvedValue(3);
      const res = await service.list({ page: 2, limit: 1 } as MediaListQueryDto);
      expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 1, take: 1 }),
      );
      expect(res.page).toBe(2);
      expect(res.limit).toBe(1);
    });
  });

  describe('remove', () => {
    it('soft-deletes and removes the storage object when nothing references it', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'm1', key: 'covers/x.jpg' });
      prisma.mediaAsset.update.mockResolvedValue({});
      storage.delete.mockResolvedValue();

      const res = await service.remove('m1');
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { isDeleted: true },
      });
      expect(storage.delete).toHaveBeenCalledWith('covers/x.jpg');
      expect(res).toEqual({ success: true, storageDeleted: true });
    });

    // 🔴 Главная посадка LEGACY-060. Один запрос сносил обложку опубликованной книги,
    // ответ был `{ success: true }`, а `coverImageUrl` продолжал указывать в пустоту.
    // Восстановление возможно только повторной загрузкой файла — значит отказ.
    it('refuses to delete a cover that a book version still uses', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'm1', key: 'covers/x.jpg' });
      prisma.bookVersion.findMany.mockResolvedValue([{ id: 'v1', title: 'War and Peace' }]);

      await expect(service.remove('m1')).rejects.toBeInstanceOf(ConflictException);

      // Ни записи не тронули, ни файла: отказ обязан быть полным.
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete audio a chapter still uses, found by the foreign key', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'm1', key: 'audio/ch1.mp3' });
      prisma.audioChapter.findMany.mockImplementation((args: { where?: { mediaId?: string } }) =>
        Promise.resolve(args?.where?.mediaId === 'm1' ? [{ id: 'a1', title: 'Chapter 1' }] : []),
      );

      await expect(service.remove('m1')).rejects.toBeInstanceOf(ConflictException);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('names what blocks the deletion — an operator has to know what to fix', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'm1', key: 'covers/x.jpg' });
      prisma.bookVersion.findMany.mockResolvedValue([{ id: 'v1', title: 'War and Peace' }]);

      await expect(service.remove('m1')).rejects.toMatchObject({
        response: { references: ['book version "War and Peace" (v1)'] },
      });
    });

    it('reports a storage failure instead of swallowing it', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({ id: 'm1', key: 'covers/x.jpg' });
      prisma.mediaAsset.update.mockResolvedValue({});
      storage.delete.mockRejectedValue(new Error('fs fail'));

      const res = await service.remove('m1');
      // Повтор остаётся возможным, но объект пережил удаление записи — это сирота,
      // и вызывающий узнаёт об этом из ответа, а не из тишины.
      expect(res).toEqual({ success: true, storageDeleted: false });
    });

    it('throws NotFound if media not found', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
