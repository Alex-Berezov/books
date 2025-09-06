import { NotFoundException } from '@nestjs/common';
import { SeoService } from './seo.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language } from '@prisma/client';

type PrismaStub = {
  book: { findUnique: jest.Mock };
  bookVersion: { findUnique: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
  page: { findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
  seo: { findUnique: jest.Mock };
};

const createPrismaStub = (): PrismaStub => ({
  book: { findUnique: jest.fn() },
  bookVersion: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  page: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  seo: { findUnique: jest.fn() },
});

describe('SeoService (unit)', () => {
  let service: SeoService;
  let prisma: PrismaStub;
  const ORIGINAL_ENV = process.env;
  type SeoBundle = {
    meta: { canonicalUrl: string; title: string; description?: string | null };
    openGraph: { image?: { url: string; alt?: string } };
    twitter: { card: string };
    schema?: {
      event?: {
        name: string;
        description?: string;
        startDate?: string;
        endDate?: string;
        url?: string;
        image?: string;
        location?: {
          name: string;
          street?: string;
          city?: string;
          region?: string;
          postal?: string;
          country?: string;
        };
      };
    };
  };

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new SeoService(prisma as unknown as PrismaService);
    process.env = { ...ORIGINAL_ENV, LOCAL_PUBLIC_BASE_URL: 'http://localhost:5000/static' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetAllMocks();
  });

  describe('resolvePublic(version)', () => {
    it('returns canonical without language prefix and ignores seo canonical override', async () => {
      prisma.bookVersion.findUnique.mockResolvedValueOnce({
        id: 'v1',
        title: 'Title',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'http://img/cover.jpg',
        seoId: 10,
      });
      prisma.seo.findUnique.mockResolvedValueOnce({
        id: 10,
        canonicalUrl: 'https://evil/override',
      });

      const bundle = (await service.resolvePublic('version', 'v1')) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/versions/v1');
      expect(bundle.meta.title).toBe('Title — Author');
      expect(bundle.openGraph.image).toEqual({
        url: 'http://img/cover.jpg',
        alt: 'Title — Author',
      });
      expect(bundle.twitter.card).toBe('summary_large_image');
    });

    it('throws 404 when version not found', async () => {
      prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
      await expect(service.resolvePublic('version', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resolvePublic(book)', () => {
    beforeEach(() => {
      prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'book-slug' });
      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v-en',
          language: 'en',
          title: 'T EN',
          author: 'A',
          description: 'D EN',
          coverImageUrl: 'http://img/en.jpg',
          seoId: null,
        },
        {
          id: 'v-es',
          language: 'es',
          title: 'T ES',
          author: 'A',
          description: 'D ES',
          coverImageUrl: 'http://img/es.jpg',
          seoId: null,
        },
      ]);
    });

    it('prefers path language when available', async () => {
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        pathLang: 'es' as Language,
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/es/books/book-slug');
      expect(bundle.meta.title).toBe('T ES — A');
    });

    it('uses query lang when path lang is not provided', async () => {
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        queryLang: 'en',
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/books/book-slug');
      expect(bundle.meta.title).toBe('T EN — A');
    });

    it('falls back to Accept-Language if query missing', async () => {
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        acceptLanguage: 'es;q=0.9,en;q=0.8',
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/es/books/book-slug');
      expect(bundle.meta.title).toBe('T ES — A');
    });

    it('handles no versions by using default language and book slug title', async () => {
      prisma.bookVersion.findMany.mockResolvedValueOnce([]);
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        pathLang: 'en' as Language,
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/books/book-slug');
      expect(bundle.meta.title).toBe('Book book-slug');
    });
  });

  describe('resolvePublic(page)', () => {
    it('chooses page by effective language and prefixes canonical', async () => {
      prisma.page.findMany.mockResolvedValueOnce([
        { id: 'p-en', language: 'en' },
        { id: 'p-es', language: 'es' },
      ]);
      prisma.page.findUnique.mockResolvedValueOnce({
        id: 'p-es',
        slug: 'about',
        title: 'Sobre',
        seoId: null,
      });

      const bundle = (await service.resolvePublic('page', 'about', {
        pathLang: 'es' as Language,
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/es/pages/about');
      expect(bundle.meta.title).toBe('Sobre');
    });

    it('throws when no published pages found', async () => {
      prisma.page.findMany.mockResolvedValueOnce([]);
      await expect(service.resolvePublic('page', 'about')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('includes schema.event when SEO contains event fields', async () => {
      prisma.page.findMany.mockResolvedValueOnce([{ id: 'p-en', language: 'en' }]);
      prisma.page.findUnique.mockResolvedValueOnce({
        id: 'p-en',
        slug: 'event',
        title: 'Event page',
        seoId: 77,
      });
      prisma.seo.findUnique.mockResolvedValueOnce({
        id: 77,
        eventName: 'Book Fair',
        eventDescription: 'Annual book fair',
        eventStartDate: new Date('2025-10-01T10:00:00Z'),
        eventEndDate: new Date('2025-10-02T18:00:00Z'),
        eventUrl: 'https://example.org/event',
        eventImageUrl: 'https://img/event.jpg',
        eventLocationName: 'Expo Center',
        eventLocationStreet: 'Main St 1',
        eventLocationCity: 'City',
        eventLocationRegion: 'Region',
        eventLocationPostal: '12345',
        eventLocationCountry: 'US',
      });

      const bundle = (await service.resolvePublic('page', 'event', {
        pathLang: 'en' as Language,
      })) as unknown as SeoBundle;

      expect(bundle.schema?.event).toEqual({
        name: 'Book Fair',
        description: 'Annual book fair',
        startDate: '2025-10-01T10:00:00.000Z',
        endDate: '2025-10-02T18:00:00.000Z',
        url: 'https://example.org/event',
        image: 'https://img/event.jpg',
        location: {
          name: 'Expo Center',
          street: 'Main St 1',
          city: 'City',
          region: 'Region',
          postal: '12345',
          country: 'US',
        },
      });
    });
  });
});
