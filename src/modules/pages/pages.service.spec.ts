import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PagesService } from './pages.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
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
  $transaction: jest.Mock;
};

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    page: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    seo: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  // Транзакция отдаёт тот же стаб как `tx`: запись истории слагов обязана идти
  // внутри неё, и подмена клиента здесь скрыла бы нарушение этого порядка.
  stub.$transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback === 'function') {
      return (callback as (tx: PrismaStub) => Promise<unknown>)(stub);
    }
    return callback;
  });

  return stub;
};

const createSlugRedirectStub = () => ({
  record: jest.fn().mockResolvedValue(undefined),
  recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
  resolve: jest.fn().mockResolvedValue(null),
});

describe('PagesService (unit)', () => {
  let service: PagesService;
  let prisma: PrismaStub;
  let slugRedirects: ReturnType<typeof createSlugRedirectStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    slugRedirects = createSlugRedirectStub();
    service = new PagesService(
      prisma as unknown as PrismaService,
      slugRedirects as unknown as SlugRedirectService,
    );
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

  describe('reserved slugs', () => {
    it('refuses to create a page whose slug a frontend route already owns', async () => {
      await expect(
        service.create(
          {
            slug: 'catalog',
            title: 'Catalog',
            type: 'generic',
            content: '',
          } as unknown as import('./dto/create-page.dto').CreatePageDto,
          'en' as Language,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.page.create).not.toHaveBeenCalled();
    });

    it('is case- and whitespace-insensitive', async () => {
      await expect(
        service.create(
          {
            slug: '  CATALOG ',
            title: 'Catalog',
            type: 'generic',
            content: '',
          } as unknown as import('./dto/create-page.dto').CreatePageDto,
          'en' as Language,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.page.create).not.toHaveBeenCalled();
    });

    it('leaves ordinary slugs alone', async () => {
      prisma.page.create.mockResolvedValueOnce({ id: 'p1', slug: 'about-us' });
      await service.create(
        {
          slug: 'about-us',
          title: 'About',
          type: 'generic',
          content: '',
        } as unknown as import('./dto/create-page.dto').CreatePageDto,
        'en' as Language,
      );
      expect(prisma.page.create).toHaveBeenCalled();
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

    it('rejects renaming a page into a slug the router owns', async () => {
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'about', language: 'en' });
      await expect(
        service.update('p1', {
          slug: 'catalog',
        } as unknown as import('./dto/update-page.dto').UpdatePageDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Nothing may reach the database: a rejected rename must not leave a
      // SlugRedirect pointing at an address the router will never yield.
      expect(prisma.page.update).not.toHaveBeenCalled();
      expect(slugRedirects.record).not.toHaveBeenCalled();
      expect(slugRedirects.recordBaseSlugChange).not.toHaveBeenCalled();
    });

    it('still lets a page already sitting on a reserved slug be edited', async () => {
      // Such a page predates the rule. Refusing it would brick the only form its
      // owner could use to rename it away.
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'catalog', language: 'en' });
      prisma.page.findFirst.mockResolvedValueOnce(null);
      prisma.page.update.mockResolvedValueOnce({ id: 'p1', slug: 'catalog', title: 'Renamed' });

      await service.update('p1', {
        slug: 'catalog',
        title: 'Renamed',
      } as unknown as import('./dto/update-page.dto').UpdatePageDto);

      expect(prisma.page.update).toHaveBeenCalled();
    });

    it('refuses to carry a grandfathered reserved slug into another language', async () => {
      // The exemption is "leave the broken page where it is", not "let it
      // travel": moving `catalog` from en to ru mints a second unreachable
      // address in a language that was intact.
      prisma.page.findUnique.mockResolvedValueOnce({ id: 'p1', slug: 'catalog', language: 'en' });
      await expect(
        service.update('p1', {
          language: 'ru',
        } as unknown as import('./dto/update-page.dto').UpdatePageDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.page.update).not.toHaveBeenCalled();
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
