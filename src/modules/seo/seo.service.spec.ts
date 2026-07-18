import { NotFoundException } from '@nestjs/common';
import { SeoService } from './seo.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language } from '@prisma/client';

type PrismaStub = {
  book: { findUnique: jest.Mock };
  bookVersion: { findUnique: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
  page: { findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
  seo: { findUnique: jest.Mock };
  bookCategory: { findMany: jest.Mock };
  bookRating: { findMany: jest.Mock };
  categoryTranslation: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
  category: { findUnique: jest.Mock };
  tagTranslation: { findUnique: jest.Mock; findMany: jest.Mock };
};

const createPrismaStub = (): PrismaStub => ({
  book: { findUnique: jest.fn() },
  bookVersion: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  page: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  seo: { findUnique: jest.fn() },
  bookCategory: { findMany: jest.fn().mockResolvedValue([]) },
  bookRating: { findMany: jest.fn().mockResolvedValue([]) },
  categoryTranslation: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  category: { findUnique: jest.fn() },
  tagTranslation: { findUnique: jest.fn(), findMany: jest.fn() },
});

describe('SeoService (unit)', () => {
  let service: SeoService;
  let prisma: PrismaStub;
  const ORIGINAL_ENV = process.env;
  type SeoBundle = {
    meta: { canonicalUrl: string; title: string; description?: string | null };
    openGraph: { image?: { url: string; alt?: string }; type?: string };
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
        status: 'published',
        type: 'text',
        language: 'en',
      });
      prisma.seo.findUnique.mockResolvedValueOnce({
        id: 10,
        canonicalUrl: 'https://evil/override',
      });

      const bundle = (await service.resolvePublic('version', 'v1')) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/versions/v1');
      expect(bundle.meta.title).toBe('Title by Author | Read & Listen Free | Bibliaris');
      expect(bundle.openGraph.image).toEqual({
        url: 'http://img/cover.jpg',
        alt: 'Title by Author | Read & Listen Free | Bibliaris',
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
      prisma.bookVersion.findFirst.mockResolvedValue(null);
      prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'book-slug' });
      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v-en',
          bookId: 'b1',
          language: 'en',
          title: 'T EN',
          author: 'A',
          description: 'D EN',
          coverImageUrl: 'http://img/en.jpg',
          seoId: null,
          slug: 't-en',
          status: 'published',
          type: 'text',
        },
        {
          id: 'v-es',
          bookId: 'b1',
          language: 'es',
          title: 'T ES',
          author: 'A',
          description: 'D ES',
          coverImageUrl: 'http://img/es.jpg',
          seoId: null,
          slug: 't-es',
          status: 'published',
          type: 'text',
        },
      ]);
    });

    it('prefers path language when available', async () => {
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        pathLang: 'es' as Language,
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/es/book/t-es');
      expect(bundle.meta.title).toBe('T ES de A | Leer y escuchar gratis');
    });

    it('uses query lang when path lang is not provided', async () => {
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        queryLang: 'en',
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/book/t-en');
      expect(bundle.meta.title).toBe('T EN by A | Read & Listen Free | Bibliaris');
    });

    it('falls back to Accept-Language if query missing', async () => {
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        acceptLanguage: 'es;q=0.9,en;q=0.8',
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/es/book/t-es');
      expect(bundle.meta.title).toBe('T ES de A | Leer y escuchar gratis');
    });

    it('handles no versions by using default language and book slug title', async () => {
      prisma.bookVersion.findMany.mockResolvedValueOnce([]);
      const bundle = (await service.resolvePublic('book', 'book-slug', {
        pathLang: 'en' as Language,
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/book/book-slug');
      expect(bundle.meta.title).toBe('Book book-slug');
    });
  });

  describe('resolvePublic(page)', () => {
    it('chooses page by effective language and prefixes canonical', async () => {
      prisma.page.findMany.mockResolvedValueOnce([
        { id: 'p-en', language: 'en', slug: 'about' },
        { id: 'p-es', language: 'es', slug: 'about' },
      ]);
      prisma.page.findUnique.mockResolvedValueOnce({
        id: 'p-es',
        slug: 'about',
        title: 'Sobre',
        content: 'Content',
        seoId: null,
        status: 'published',
      });

      const bundle = (await service.resolvePublic('page', 'about', {
        pathLang: 'es' as Language,
      })) as unknown as SeoBundle;
      expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/es/pages/about');
      expect(bundle.meta.title).toBe('Sobre | Bibliaris');
    });

    it('throws when no published pages found', async () => {
      prisma.page.findMany.mockResolvedValueOnce([]);
      await expect(service.resolvePublic('page', 'about')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('includes schema.event when SEO contains event fields', async () => {
      prisma.page.findMany.mockResolvedValueOnce([{ id: 'p-en', language: 'en', slug: 'event' }]);
      prisma.page.findUnique.mockResolvedValueOnce({
        id: 'p-en',
        slug: 'event',
        title: 'Event page',
        content: 'Event Content',
        seoId: 77,
        status: 'published',
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

  describe('resolvePublic(category) — hreflangs from all translations', () => {
    const categoryId = 'cat-uuid-1';
    const allTranslations = [
      { id: 'ct-en', categoryId, language: Language.en, slug: 'fiction', name: 'Fiction' },
      { id: 'ct-es', categoryId, language: Language.es, slug: 'ficcion', name: 'Ficción' },
      { id: 'ct-fr', categoryId, language: Language.fr, slug: 'fiction', name: 'Fiction' },
      { id: 'ct-pt', categoryId, language: Language.pt, slug: 'ficcao', name: 'Ficção' },
      {
        id: 'ct-ru',
        categoryId,
        language: Language.ru,
        slug: 'khudozhestvennaya',
        name: 'Художественная',
      },
    ];
    const categoryObj = {
      id: categoryId,
      name: 'Fiction',
      slug: 'fiction',
      type: 'category',
      parentId: null,
      indexable: true,
    };

    beforeEach(() => {
      prisma.categoryTranslation.findMany
        .mockResolvedValueOnce([{ ...allTranslations[0], category: categoryObj }])
        .mockResolvedValueOnce(allTranslations);
    });

    it('returns hreflangs for all 5 translations', async () => {
      const result = await service.resolvePublic('category', 'fiction', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const langCodes = hreflangs.filter((h) => h.hreflang !== 'x-default').map((h) => h.hreflang);
      expect(langCodes).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'pt', 'ru']));
      expect(langCodes).toHaveLength(5);
    });

    it('uses per-language slug in href', async () => {
      const result = await service.resolvePublic('category', 'fiction', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const esLink = hreflangs.find((h) => h.hreflang === 'es');
      expect(esLink?.href).toContain('/es/category/ficcion');
      const ruLink = hreflangs.find((h) => h.hreflang === 'ru');
      expect(ruLink?.href).toContain('/ru/category/khudozhestvennaya');
    });

    it('x-default points to English slug', async () => {
      const result = await service.resolvePublic('category', 'fiction', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const xDefault = hreflangs.find((h) => h.hreflang === 'x-default');
      expect(xDefault?.href).toContain('/en/category/fiction');
    });

    it('keeps canonical on current language and slug', async () => {
      const result = await service.resolvePublic('category', 'fiction', {
        pathLang: Language.en,
      });
      const meta = result.meta as { canonicalUrl: string };
      expect(meta.canonicalUrl).toContain('/en/category/fiction');
    });
  });

  describe('resolvePublic(genre) — hreflangs from all translations', () => {
    const genreId = 'genre-uuid-1';
    const allTranslations = [
      { id: 'gt-en', categoryId: genreId, language: Language.en, slug: 'mystery', name: 'Mystery' },
      {
        id: 'gt-es',
        categoryId: genreId,
        language: Language.es,
        slug: 'misterio',
        name: 'Misterio',
      },
      { id: 'gt-fr', categoryId: genreId, language: Language.fr, slug: 'mystere', name: 'Mystère' },
      {
        id: 'gt-pt',
        categoryId: genreId,
        language: Language.pt,
        slug: 'misterio',
        name: 'Mistério',
      },
      {
        id: 'gt-ru',
        categoryId: genreId,
        language: Language.ru,
        slug: 'detektiv',
        name: 'Детектив',
      },
    ];
    const genreObj = {
      id: genreId,
      name: 'Mystery',
      slug: 'mystery',
      type: 'genre',
      parentId: null,
      indexable: true,
    };

    beforeEach(() => {
      prisma.categoryTranslation.findMany
        .mockResolvedValueOnce([{ ...allTranslations[0], category: genreObj }])
        .mockResolvedValueOnce(allTranslations);
    });

    it('returns hreflangs for all 5 translations', async () => {
      const result = await service.resolvePublic('genre', 'mystery', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const langCodes = hreflangs.filter((h) => h.hreflang !== 'x-default').map((h) => h.hreflang);
      expect(langCodes).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'pt', 'ru']));
      expect(langCodes).toHaveLength(5);
    });

    it('uses per-language slug in href', async () => {
      const result = await service.resolvePublic('genre', 'mystery', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const esLink = hreflangs.find((h) => h.hreflang === 'es');
      expect(esLink?.href).toContain('/es/genre/misterio');
    });
  });

  describe('resolvePublic(collection) — hreflangs from all translations', () => {
    const collectionId = 'col-uuid-1';
    const allTranslations = [
      {
        id: 'clt-en',
        categoryId: collectionId,
        language: Language.en,
        slug: 'classics',
        name: 'Classics',
      },
      {
        id: 'clt-es',
        categoryId: collectionId,
        language: Language.es,
        slug: 'clasicos',
        name: 'Clásicos',
      },
      {
        id: 'clt-fr',
        categoryId: collectionId,
        language: Language.fr,
        slug: 'classiques',
        name: 'Classiques',
      },
      {
        id: 'clt-pt',
        categoryId: collectionId,
        language: Language.pt,
        slug: 'classicos',
        name: 'Clássicos',
      },
      {
        id: 'clt-ru',
        categoryId: collectionId,
        language: Language.ru,
        slug: 'klassika',
        name: 'Классика',
      },
    ];
    const colObj = {
      id: collectionId,
      name: 'Classics',
      slug: 'classics',
      type: 'collection',
      parentId: null,
      indexable: true,
    };

    beforeEach(() => {
      prisma.categoryTranslation.findMany
        .mockResolvedValueOnce([{ ...allTranslations[0], category: colObj }])
        .mockResolvedValueOnce(allTranslations);
    });

    it('returns hreflangs for all 5 translations', async () => {
      const result = await service.resolvePublic('collection', 'classics', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const langCodes = hreflangs.filter((h) => h.hreflang !== 'x-default').map((h) => h.hreflang);
      expect(langCodes).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'pt', 'ru']));
      expect(langCodes).toHaveLength(5);
    });

    it('uses per-language slug in href', async () => {
      const result = await service.resolvePublic('collection', 'classics', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const frLink = hreflangs.find((h) => h.hreflang === 'fr');
      expect(frLink?.href).toContain('/fr/collection/classiques');
    });
  });

  describe('resolvePublic(tag) — hreflangs from all translations', () => {
    const tagId = 'tag-uuid-1';
    const allTranslations = [
      { id: 'tt-en', tagId, language: Language.en, slug: 'love', name: 'Love', indexable: true },
      { id: 'tt-es', tagId, language: Language.es, slug: 'amor', name: 'Amor', indexable: true },
      { id: 'tt-fr', tagId, language: Language.fr, slug: 'amour', name: 'Amour', indexable: true },
      { id: 'tt-pt', tagId, language: Language.pt, slug: 'amor', name: 'Amor', indexable: true },
      {
        id: 'tt-ru',
        tagId,
        language: Language.ru,
        slug: 'lyubov',
        name: 'Любовь',
        indexable: true,
      },
    ];
    const tagObj = { id: tagId, name: 'Love', indexable: true };

    beforeEach(() => {
      prisma.tagTranslation.findMany
        .mockResolvedValueOnce([{ ...allTranslations[0], tag: tagObj }])
        .mockResolvedValueOnce(allTranslations);
    });

    it('returns hreflangs for all 5 translations', async () => {
      const result = await service.resolvePublic('tag', 'love', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const langCodes = hreflangs.filter((h) => h.hreflang !== 'x-default').map((h) => h.hreflang);
      expect(langCodes).toEqual(expect.arrayContaining(['en', 'es', 'fr', 'pt', 'ru']));
      expect(langCodes).toHaveLength(5);
    });

    it('uses per-language slug in href', async () => {
      const result = await service.resolvePublic('tag', 'love', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const esLink = hreflangs.find((h) => h.hreflang === 'es');
      expect(esLink?.href).toContain('/es/tag/amor');
      const ruLink = hreflangs.find((h) => h.hreflang === 'ru');
      expect(ruLink?.href).toContain('/ru/tag/lyubov');
    });
  });

  describe('resolvePublic fallback — no English translation', () => {
    it('x-default points to first available language', async () => {
      const categoryId = 'cat-no-en';
      const translations = [
        { id: 'ct-es', categoryId, language: Language.es, slug: 'ficcion', name: 'Ficción' },
        { id: 'ct-fr', categoryId, language: Language.fr, slug: 'fiction', name: 'Fiction' },
      ];
      const catObj = {
        id: categoryId,
        name: 'Ficción',
        slug: 'ficcion',
        type: 'category',
        parentId: null,
        indexable: true,
      };

      prisma.categoryTranslation.findMany
        .mockResolvedValueOnce([{ ...translations[0], category: catObj }])
        .mockResolvedValueOnce(translations);

      const result = await service.resolvePublic('category', 'ficcion', {
        pathLang: Language.es,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const xDefault = hreflangs.find((h) => h.hreflang === 'x-default');
      expect(xDefault).toBeDefined();
      expect(xDefault?.href).toContain('/es/category/ficcion');
    });

    it('missing translation does not break response', async () => {
      const categoryId = 'cat-partial';
      const translations = [
        { id: 'ct-en', categoryId, language: Language.en, slug: 'fiction', name: 'Fiction' },
        {
          id: 'ct-ru',
          categoryId,
          language: Language.ru,
          slug: 'khudozhestvennaya',
          name: 'Художественная',
        },
      ];
      const catObj = {
        id: categoryId,
        name: 'Fiction',
        slug: 'fiction',
        type: 'category',
        parentId: null,
        indexable: true,
      };

      prisma.categoryTranslation.findMany
        .mockResolvedValueOnce([{ ...translations[0], category: catObj }])
        .mockResolvedValueOnce(translations);

      const result = await service.resolvePublic('category', 'fiction', {
        pathLang: Language.en,
      });
      const hreflangs = result.hreflangs as Array<{ hreflang: string; href: string }>;
      const langCodes = hreflangs.filter((h) => h.hreflang !== 'x-default').map((h) => h.hreflang);
      expect(langCodes).toEqual(expect.arrayContaining(['en', 'ru']));
      expect(langCodes).not.toEqual(expect.arrayContaining(['es', 'fr', 'pt']));
      expect(langCodes).toHaveLength(2);
    });
  });
});
