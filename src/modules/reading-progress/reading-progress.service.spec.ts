import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReadingProgressService } from './reading-progress.service';

interface PrismaStub {
  bookVersion: { findUnique: jest.Mock };
  chapter: { findFirst: jest.Mock };
  audioChapter: { findFirst: jest.Mock };
  readingProgress: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  bookVersion: { findUnique: jest.fn() },
  chapter: { findFirst: jest.fn() },
  audioChapter: { findFirst: jest.fn() },
  readingProgress: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
});

describe('ReadingProgressService', () => {
  let service: ReadingProgressService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new ReadingProgressService(prisma as unknown as PrismaService);
  });

  describe('get()', () => {
    it('returns null when not found', async () => {
      prisma.readingProgress.findFirst.mockResolvedValueOnce(null);
      const res = await service.get('u1', 'v1');
      expect(res).toBeNull();
    });

    it('returns existing progress', async () => {
      const progress = { id: 'p1' };
      prisma.readingProgress.findFirst.mockResolvedValueOnce(progress);
      const res = await service.get('u1', 'v1');
      expect(res).toBe(progress as any);
    });
  });

  describe('upsert()', () => {
    it('throws if version not found', async () => {
      prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.upsert('u1', 'v1', { chapterNumber: 1, position: 0.5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('validates chapter exists and position range', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
      prisma.chapter.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.upsert('u1', 'v1', { chapterNumber: 1, position: 0.5 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.chapter.findFirst.mockResolvedValueOnce({ id: 'ch1' });
      await expect(
        service.upsert('u1', 'v1', { chapterNumber: 1, position: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('validates audio exists and position range', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
      prisma.audioChapter.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.upsert('u1', 'v1', { audioChapterNumber: 1, position: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.audioChapter.findFirst.mockResolvedValueOnce({ id: 'a1', duration: 10 });
      await expect(
        service.upsert('u1', 'v1', { audioChapterNumber: 1, position: 11 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates when missing and updates when exists', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
      prisma.chapter.findFirst.mockResolvedValue({ id: 'ch1' });
      prisma.readingProgress.findFirst.mockResolvedValueOnce(null);
      const created = { id: 'p1' };
      prisma.readingProgress.create.mockResolvedValueOnce(created);
      const res1 = await service.upsert('u1', 'v1', { chapterNumber: 1, position: 0.5 });
      expect(res1).toBe(created as any);

      prisma.readingProgress.findFirst.mockResolvedValueOnce({ id: 'p1' });
      prisma.readingProgress.update.mockResolvedValueOnce({ id: 'p1', position: 0.6 } as any);
      const res2 = await service.upsert('u1', 'v1', { chapterNumber: 1, position: 0.6 });
      expect(res2).toEqual({ id: 'p1', position: 0.6 });
    });

    it('handles unique race: create fails then update existing', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
      prisma.chapter.findFirst.mockResolvedValue({ id: 'ch1' });
      prisma.readingProgress.findFirst.mockResolvedValueOnce(null);
      prisma.readingProgress.create.mockRejectedValueOnce(new Error('unique violation'));
      prisma.readingProgress.findFirst.mockResolvedValueOnce({ id: 'p1' });
      prisma.readingProgress.update.mockResolvedValueOnce({ id: 'p1', position: 0.7 } as any);
      const res = await service.upsert('u1', 'v1', { chapterNumber: 1, position: 0.7 });
      expect(res).toEqual({ id: 'p1', position: 0.7 });
    });
  });
});
