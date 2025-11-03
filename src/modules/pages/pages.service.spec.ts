import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PagesService } from './pages.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language, PublicationStatus } from '@prisma/client';

type PrismaStub = {
  page: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  seo: { findUnique: jest.Mock };
};

const createPrismaStub = (): PrismaStub => ({
  page: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  seo: { findUnique: jest.fn() },
});

describe('PagesService (unit)', () => {
  let service: PagesService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new PagesService(prisma as unknown as PrismaService);
  });

  describe('getPublicBySlug', () => {
    it('returns page by slug and language', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      const res = await service.getPublicBySlug('about', 'en' as Language);
      expect(res).toEqual({ id: 'p1', slug: 'about', language: 'en' });
      expect(prisma.page.findFirst).toHaveBeenCalledWith({
        where: { slug: 'about', language: 'en', status: 'published' },
        include: { seo: true },
      });
    });

    it('throws 404 when not found', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);
      await expect(service.getPublicBySlug('about', 'en' as Language)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getPublicBySlugWithPolicy', () => {
    it('prefers queryLang, then Accept-Language, then default', async () => {
      prisma.page.findMany.mockResolvedValueOnce([
        { id: 'p-en', language: 'en' },
        { id: 'p-es', language: 'es' },
      ]);
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p-es', slug: 'about', language: 'es' });

      const chosenEs = await service.getPublicBySlugWithPolicy('about', 'es', undefined);
      expect(chosenEs).toEqual({ id: 'p-es', slug: 'about', language: 'es' });

      // Accept-Language fallback
      prisma.page.findMany.mockResolvedValueOnce([
        { id: 'p-en', language: 'en' },
        { id: 'p-es', language: 'es' },
      ]);
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p-en', slug: 'about', language: 'en' });
      const chosenEn = await service.getPublicBySlugWithPolicy(
        'about',
        undefined,
        'en-GB,en;q=0.9',
      );
      expect(chosenEn).toEqual({ id: 'p-en', slug: 'about', language: 'en' });

      // Default fallback to first candidate when nothing matches
      prisma.page.findMany.mockResolvedValueOnce([{ id: 'p-en', language: 'en' }]);
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p-en', slug: 'about', language: 'en' });
      const chosenDefault = await service.getPublicBySlugWithPolicy('about');
      expect(chosenDefault).toEqual({ id: 'p-en', slug: 'about', language: 'en' });
    });

    it('throws when no published pages with slug', async () => {
      prisma.page.findMany.mockResolvedValueOnce([]);
      await expect(service.getPublicBySlugWithPolicy('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setStatus (publish/unpublish)', () => {
    it('updates status when page exists', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1' });
      prisma.page.update.mockResolvedValueOnce({ id: 'p1', status: 'published' });
      const res = await service.setStatus('p1', 'published' as PublicationStatus);
      expect(res).toEqual({ id: 'p1', status: 'published' });
      expect(prisma.page.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: 'published' },
        include: { seo: true },
      });
    });

    it('throws 404 when page not found', async () => {
      prisma.page.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.setStatus('p1', 'published' as PublicationStatus),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update (negative seoId cases)', () => {
    it('throws BadRequest when seoId points to non-existing SEO (pre-check)', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      prisma.seo.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.update('p1', {
          seoId: 999,
        } as unknown as import('./dto/update-page.dto').UpdatePageDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps Prisma P2003 (Page_seoId_fkey) to BadRequest', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      prisma.seo.findUnique.mockResolvedValueOnce({ id: 5 }); // pass pre-check
      const err = Object.assign(new Error('fk error'), {
        code: 'P2003',
        meta: { constraint: 'Page_seoId_fkey' },
      });
      prisma.page.update.mockRejectedValueOnce(err);
      await expect(
        service.update('p1', {
          seoId: 5,
        } as unknown as import('./dto/update-page.dto').UpdatePageDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
