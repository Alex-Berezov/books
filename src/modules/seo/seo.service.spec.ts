import { Logger, NotFoundException } from '@nestjs/common';
import { SeoService } from './seo.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoryTreeService, CATEGORY_TREE_MAX_DEPTH } from '../category/category-tree.service';
import { Language } from '@prisma/client';
import { DEGRADED_RESPONSE } from '../../common/interceptors/degraded-response';

type PrismaStub = {
  book: { findUnique: jest.Mock };
  bookVersion: { findUnique: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
  page: { findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
  seo: { findUnique: jest.Mock };
  bookCategory: { findMany: jest.Mock };
  bookRating: { findMany: jest.Mock; aggregate: jest.Mock };
  categoryTranslation: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
  category: { findUnique: jest.Mock };
  tagTranslation: { findUnique: jest.Mock; findMany: jest.Mock };
  comment: { findMany: jest.Mock };
};

const createPrismaStub = (): PrismaStub => ({
  book: { findUnique: jest.fn() },
  bookVersion: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  page: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  seo: { findUnique: jest.fn() },
  bookCategory: { findMany: jest.fn().mockResolvedValue([]) },
  bookRating: {
    findMany: jest.fn().mockResolvedValue([]),
    // 🔴 `LEGACY-307`. Среднее и количество считает база: `findMany` без
    // потолка тянул в память все строки рейтинга книги ради двух чисел.
    aggregate: jest.fn().mockResolvedValue({ _avg: { score: null }, _count: { _all: 0 } }),
  },
  categoryTranslation: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  category: { findUnique: jest.fn() },
  tagTranslation: { findUnique: jest.fn(), findMany: jest.fn() },
  comment: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('SeoService (unit)', () => {
  let service: SeoService;
  let prisma: PrismaStub;
  const ORIGINAL_ENV = process.env;
  type SeoBundle = {
    meta: { canonicalUrl: string; title: string; description?: string | null };
    openGraph: { image?: { url: string; alt?: string }; type?: string };
    twitter: { card: string };
    breadcrumbPath?: Array<{ name: string; slug: string }>;
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
    service = new SeoService(
      prisma as unknown as PrismaService,
      new CategoryTreeService(prisma as unknown as PrismaService),
    );
    process.env = { ...ORIGINAL_ENV, PUBLIC_SITE_URL: 'http://localhost:5000/static' };
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

  /**
   * 🔴 `LEGACY-309`. Ветки `category`, `collection` и `genre` были копиями друг
   * друга: 34 строки различий из 130, остальное совпадало дословно, а имя типа
   * писалось руками отдельным литералом в каждой копии. Правка любого правила
   * публичной выдачи таксономии проходила мимо двух копий из трёх, и ни
   * компилятор, ни линт этого не видели — литерал брался из допустимого union.
   * Отсюда `LEGACY-273` (в ветку `genre` вписали `'collection'`) и три из семи
   * блоков `LEGACY-277`.
   *
   * ⚠️ Спека на один тип таксономии тут бесполезна по определению: она зеленела
   * и на разошедшихся копиях. Проверять надо все три одним набором ожиданий.
   */
  describe.each([
    ['category', 'Category translation not found', [] as Array<{ name: string; slug: string }>],
    [
      'collection',
      'Collection not found',
      [{ name: 'Collections', slug: 'collections' }] as Array<{ name: string; slug: string }>,
    ],
    ['genre', 'Genre translation not found', [] as Array<{ name: string; slug: string }>],
  ] as const)(
    'resolvePublic(%s) — три типа таксономии идут одним кодом (LEGACY-309)',
    (termType, notFoundText, expectedPath) => {
      const categoryId = 'tax-uuid-1';
      const translation = {
        id: 'tt-en',
        categoryId,
        language: Language.en,
        slug: 'the-term',
        name: 'The Term',
        description: null,
        seoId: null,
        autoIndexable: true,
        category: {
          id: categoryId,
          name: 'The Term',
          slug: 'the-term',
          type: termType,
          parentId: null,
          indexable: true,
        },
      };

      it('канонический адрес строится из типа страницы, а не из литерала соседней ветки', async () => {
        prisma.categoryTranslation.findMany
          .mockResolvedValueOnce([translation])
          .mockResolvedValueOnce([translation]);

        const bundle = await service.resolvePublic(termType, 'the-term', {
          pathLang: Language.en,
        });

        expect((bundle.meta as { canonicalUrl: string }).canonicalUrl).toContain(
          `/en/${termType}/the-term`,
        );
      });

      it('текст 404 называет запрошенный тип термина', async () => {
        prisma.categoryTranslation.findMany.mockResolvedValueOnce([]);

        await expect(
          service.resolvePublic(termType, 'missing', { pathLang: Language.en }),
        ).rejects.toThrow(notFoundText);
      });

      it('крошки начинаются с главной, а раздел стоит только у коллекций', async () => {
        prisma.categoryTranslation.findMany
          .mockResolvedValueOnce([translation])
          .mockResolvedValueOnce([translation]);

        const bundle = await service.resolvePublic(termType, 'the-term', {
          pathLang: Language.en,
        });

        expect(bundle.breadcrumbPath).toEqual(expectedPath);
      });
    },
  );

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

  // 🔴 LEGACY-277: семь блоков `resolvePublic` глушили отказ базы пустым
  // `catch`. Ответ 200 с обеднённым JSON-LD — поведение задуманное и здесь
  // не меняется; проверяется ровно то, что отказ перестал быть невидимым.
  // Каждый случай роняет свой вызов Prisma: посадка на один блок ничего
  // не говорит про остальные шесть.
  describe('resolvePublic — отказ базы на необязательном блоке не пропадает молча (LEGACY-277)', () => {
    let warn: jest.SpyInstance;

    const warnedParts = () =>
      warn.mock.calls.map((call) => String(call[0])).filter((msg) => msg.startsWith('SEO '));

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    describe('страница книги', () => {
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
            coverImageUrl: null,
            seoId: null,
            slug: 't-en',
            status: 'published',
            type: 'text',
            primaryCategoryId: null,
          },
        ]);
      });

      const resolveBook = () =>
        service.resolvePublic('book', 'book-slug', {
          pathLang: Language.en,
        }) as unknown as Promise<SeoBundle>;

      it('отказ на крошках: ответ 200 без крошек, в логе — след', async () => {
        prisma.bookCategory.findMany.mockRejectedValueOnce(new Error('db is down'));

        const bundle = await resolveBook();

        expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/book/t-en');
        expect(bundle.breadcrumbPath).toEqual([]);
        expect(warnedParts()).toEqual([
          expect.stringContaining('failed to load breadcrumb categories'),
        ]);
        expect(warnedParts()[0]).toContain('db is down');
      });

      /**
       * 🔴 `LEGACY-305`. Лог показывал ОДИН случай деградации, а страниц
       * с обеднённой разметкой поисковик видел столько, сколько их запросят
       * за час: ответ уезжал на общий кэш с `s-maxage=300` и
       * `stale-while-revalidate=3600`. Метку снимает `PublicCacheInterceptor`
       * и переводит такой ответ на короткий кэш.
       *
       * ⚠️ Метка — символ, поэтому тело ответа не меняется ни на байт:
       * это проверяется здесь же, иначе правка тихо стала бы сменой контракта.
       */
      it('деградировавший ответ помечен для кэша, а тело не меняется (LEGACY-305)', async () => {
        prisma.bookCategory.findMany.mockRejectedValueOnce(new Error('db is down'));

        const bundle = await resolveBook();

        expect((bundle as unknown as Record<symbol, unknown>)[DEGRADED_RESPONSE]).toBe(true);
        const serialised = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
        expect(Object.keys(serialised)).not.toContain('degraded');
      });

      it('здоровый ответ метки не несёт (LEGACY-305)', async () => {
        const bundle = await resolveBook();

        expect((bundle as unknown as Record<symbol, unknown>)[DEGRADED_RESPONSE]).toBeUndefined();
      });

      /**
       * 🔴 `LEGACY-307`. Среднее и количество считает база одним `aggregate`,
       * а не приложение по всем строкам рейтинга: прежний `findMany` без
       * потолка тянул в память столько строк, сколько у книги оценок.
       *
       * ⚠️ Проверяется и форма ответа: `AggregateRating` попадает в схему
       * только от трёх оценок (`generateBookSchema`), и подмена агрегата
       * не должна её сдвинуть.
       */
      it('рейтинг считается агрегатом, а не выборкой всех оценок (LEGACY-307)', async () => {
        prisma.bookRating.aggregate.mockResolvedValueOnce({
          _avg: { score: 4.333333 },
          _count: { _all: 9 },
        });

        const bundle = await resolveBook();

        expect(prisma.bookRating.findMany).not.toHaveBeenCalled();
        expect(prisma.bookRating.aggregate).toHaveBeenCalledWith(
          expect.objectContaining({ _avg: { score: true }, _count: { _all: true } }),
        );
        const graph = (bundle.schema as { '@graph': Array<Record<string, unknown>> })['@graph'];
        const book = graph.find((node) => node.aggregateRating) as
          | { aggregateRating: Record<string, string> }
          | undefined;
        expect(book?.aggregateRating).toEqual({
          '@type': 'AggregateRating',
          ratingValue: '4.33',
          ratingCount: '9',
          bestRating: '5',
          worstRating: '1',
        });
      });

      it('книга без оценок отдаётся без AggregateRating (LEGACY-307)', async () => {
        const bundle = await resolveBook();

        const graph = (bundle.schema as { '@graph': Array<Record<string, unknown>> })['@graph'];
        expect(graph.some((node) => node.aggregateRating)).toBe(false);
      });

      it('отказ на списке жанров: ответ 200, в логе — след', async () => {
        prisma.bookCategory.findMany
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error('db is down'));

        const bundle = await resolveBook();

        expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/book/t-en');
        expect(warnedParts()).toEqual([expect.stringContaining('failed to load genre list')]);
      });

      it('отказ на рейтинге: ответ 200, в логе — след', async () => {
        prisma.bookRating.aggregate.mockRejectedValueOnce(new Error('db is down'));

        const bundle = await resolveBook();

        expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/book/t-en');
        expect(warnedParts()).toEqual([expect.stringContaining('failed to load ratings')]);
      });

      it('отказ на отзывах: ответ 200, в логе — след', async () => {
        prisma.comment.findMany.mockRejectedValueOnce(new Error('db is down'));

        const bundle = await resolveBook();

        expect(bundle.meta.canonicalUrl).toBe('http://localhost:5000/static/en/book/t-en');
        expect(warnedParts()).toEqual([expect.stringContaining('failed to load comments')]);
      });
    });

    // Крошки коллекции начинаются со статического раздела «Collections», и он
    // в `breadcrumbPath` остаётся: проверяется отсутствие предков, а не пустой
    // список вообще.
    describe.each([
      ['category', 'category', []],
      ['collection', 'collection', [{ name: 'Collections', slug: 'collections' }]],
      ['genre', 'genre', []],
    ] as const)('страница %s', (pageType, termType, expectedPath) => {
      it('отказ на подъёме к предкам: ответ 200 без крошек, в логе — след', async () => {
        const category = {
          id: 'cat-child',
          name: 'Child',
          slug: 'child',
          type: termType,
          // Предок обязателен: без него подъём не делает ни одного запроса
          // и ронять было бы нечего.
          parentId: 'cat-parent',
          indexable: true,
        };
        const translation = {
          id: 'ct-en',
          categoryId: category.id,
          language: Language.en,
          slug: 'child',
          name: 'Child',
          description: null,
          seoId: null,
          autoIndexable: true,
          category,
        };
        prisma.categoryTranslation.findMany.mockResolvedValue([translation]);
        prisma.category.findUnique.mockRejectedValue(new Error('db is down'));

        const bundle = (await service.resolvePublic(pageType, 'child', {
          pathLang: Language.en,
        })) as unknown as SeoBundle;

        expect(bundle.breadcrumbPath).toEqual(expectedPath);
        expect(warnedParts()).toEqual([
          expect.stringContaining('failed to load parent breadcrumbs'),
        ]);
        expect(warnedParts()[0]).toContain(`SEO ${pageType} "cat-child"`);
      });
    });
  });

  // 🔴 LEGACY-273: ветки `genre` и `collection` передавали в подбор запасного
  // перевода чужой тип термина. На прямом попадании в язык дефект не виден
  // вовсе — `exact` возвращает кандидата и тип не участвует. Он просыпается
  // ровно на фолбэке, поэтому здесь кандидаты намеренно без запрошенного языка,
  // а `findFirst` отдаёт перевод только при совпадении `category.type`.
  describe('resolvePublic — фолбэк подбора перевода таксономии (LEGACY-273)', () => {
    type TransFindManyArgs = { where?: { OR?: unknown } };
    type TransFindFirstArgs = { where?: { category?: { type?: string } } };

    const arrangeFallback = (type: 'genre' | 'collection') => {
      const category = {
        id: 'cat-1',
        name: 'Poetry',
        slug: 'poetry',
        type,
        parentId: null,
        indexable: true,
      };
      const enTranslation = {
        id: 'ct-en',
        categoryId: category.id,
        language: Language.en,
        slug: 'poetry',
        name: 'Poetry',
        description: null,
        seoId: null,
        autoIndexable: true,
        category,
      };
      const ruTranslation = {
        id: 'ct-ru',
        categoryId: category.id,
        language: Language.ru,
        slug: 'poeziya',
        name: 'Поэзия',
        description: null,
        seoId: null,
        autoIndexable: true,
        category,
      };

      prisma.categoryTranslation.findMany.mockImplementation((args: TransFindManyArgs) =>
        Promise.resolve(args?.where?.OR ? [enTranslation] : [enTranslation, ruTranslation]),
      );
      // Единственное, что отличает исправленный вызов от дефектного: запасной
      // запрос отдаёт перевод только под своим типом термина.
      prisma.categoryTranslation.findFirst.mockImplementation((args: TransFindFirstArgs) =>
        Promise.resolve(args?.where?.category?.type === type ? ruTranslation : null),
      );
    };

    it('страница жанра без перевода среди кандидатов берёт запасной перевод жанра, а не коллекции', async () => {
      arrangeFallback('genre');

      const result = (await service.resolvePublic('genre', 'poetry', {
        pathLang: Language.ru,
      })) as unknown as SeoBundle;

      expect(result.meta.canonicalUrl).toContain('/ru/genre/poeziya');
      // Ровно один запасной запрос: возврат дефекта «сначала чужой тип, потом
      // верный для подстраховки» прошёл бы проверку по любому вызову.
      expect(prisma.categoryTranslation.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.categoryTranslation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: { type: 'genre' } }),
        }),
      );
    });

    it('страница коллекции без перевода среди кандидатов берёт запасной перевод коллекции, а не жанра', async () => {
      arrangeFallback('collection');

      const result = (await service.resolvePublic('collection', 'poetry', {
        pathLang: Language.ru,
      })) as unknown as SeoBundle;

      expect(result.meta.canonicalUrl).toContain('/ru/collection/poeziya');
      // Ровно один запасной запрос: возврат дефекта «сначала чужой тип, потом
      // верный для подстраховки» прошёл бы проверку по любому вызову.
      expect(prisma.categoryTranslation.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.categoryTranslation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: { type: 'collection' } }),
        }),
      );
    });

    it('текст 404 называет тот тип термина, страницу которого запросили', async () => {
      arrangeFallback('genre');
      // Перевода нет ни под каким типом — важен текст отказа, а не сам отказ.
      prisma.categoryTranslation.findFirst.mockResolvedValue(null);

      await expect(
        service.resolvePublic('genre', 'poetry', { pathLang: Language.ru }),
      ).rejects.toThrow('No genre translation for language ru');
    });
  });

  // 🔴 LEGACY-265: четыре подъёма по дереву категорий на публичных маршрутах
  // `/seo/resolve` шли без потолка глубины. Петля `A → B → A` означала не
  // медленный ответ, а запрос, который не возвращается никогда.
  describe('resolvePublic — подъём по дереву категорий (LEGACY-265)', () => {
    type CategoryRow = {
      id: string;
      name: string;
      slug: string;
      type: string;
      parentId: string | null;
      indexable: boolean;
    };
    type TranslationRow = {
      id: string;
      categoryId: string;
      language: Language;
      name: string;
      slug: string;
    };
    type TransFindManyArgs = {
      where: { OR?: unknown; categoryId?: string | { in: string[] }; language?: Language };
    };

    const cat = (id: string, parentId: string | null, type = 'category'): CategoryRow => ({
      id,
      name: `Name ${id}`,
      slug: `slug-${id}`,
      type,
      parentId,
      indexable: true,
    });

    const trans = (categoryId: string, name: string, slug: string): TranslationRow => ({
      id: `tr-${categoryId}`,
      categoryId,
      language: Language.en,
      name,
      slug,
    });

    /**
     * ⚠️ Стаб считает обращения и падает на превышении потолка. Без счётчика
     * возврат дефекта дал бы не красный тест, а зависший jest, убитый по
     * таймауту, — а это выглядит как отказ среды, а не как поломанный код.
     * Тот же приём — в `category-tree.service.spec.ts`.
     */
    const wireTree = (rows: CategoryRow[], startId: string, translations: TranslationRow[]) => {
      const byId = new Map(rows.map((r) => [r.id, r]));
      let reads = 0;

      prisma.category.findUnique.mockImplementation((args: { where: { id: string } }) => {
        reads += 1;
        if (reads > CATEGORY_TREE_MAX_DEPTH * 4) {
          throw new Error(
            `category.findUnique вызван ${reads} раз — подъём по дереву идёт без потолка`,
          );
        }
        return Promise.resolve(byId.get(args.where.id) ?? null);
      });

      prisma.categoryTranslation.findMany.mockImplementation((args: TransFindManyArgs) => {
        const where = args.where;
        if (where.OR) {
          const own = translations.find(
            (tr) => tr.categoryId === startId && tr.language === Language.en,
          );
          return Promise.resolve(
            own
              ? [
                  {
                    ...own,
                    description: null,
                    seoId: null,
                    autoIndexable: true,
                    category: byId.get(startId) ?? null,
                  },
                ]
              : [],
          );
        }
        if (typeof where.categoryId === 'string') {
          const ownId = where.categoryId;
          return Promise.resolve(translations.filter((tr) => tr.categoryId === ownId));
        }
        const ids = (where.categoryId as { in: string[] }).in;
        return Promise.resolve(
          translations.filter(
            (tr) => ids.includes(tr.categoryId) && tr.language === where.language,
          ),
        );
      });

      return { reads: () => reads };
    };

    it.each(['category', 'genre', 'collection'] as const)(
      'замкнутое дерево A → B → A не вешает %s: ответ возвращается, число чтений ограничено',
      async (type) => {
        const counter = wireTree([cat('A', 'B', type), cat('B', 'A', type)], 'A', [
          trans('A', 'Node A', 'node-a'),
        ]);

        const result = await service.resolvePublic(type, 'node-a', { pathLang: Language.en });

        const path = result.breadcrumbPath as Array<{ name: string; slug: string }>;
        // Отсеиваем статическую крошку раздела (она есть только у коллекций).
        const trail = path.filter((p) => p.slug.startsWith('slug-'));
        // Подъём обрывается на петле: предок ровно один, и сам узел среди своих
        // предков не появляется.
        expect(trail).toEqual([{ name: 'Name B', slug: 'slug-b' }]);
        expect(counter.reads()).toBeLessThanOrEqual(2);
      },
    );

    /**
     * ⚠️ Петля из трёх узлов, а не из двух: подъём, где вместо множества
     * посещённых заведён один «предыдущий узел», двухузловую петлю переживает
     * и зеленеет — а на трёхузловой уходит в потолок и возвращает сам узел
     * среди своих предков.
     */
    it('петля A → B → C → A обрывается и не тащит сам узел в его предки', async () => {
      const counter = wireTree([cat('A', 'B'), cat('B', 'C'), cat('C', 'A')], 'A', [
        trans('A', 'Node A', 'node-a'),
      ]);

      const result = await service.resolvePublic('category', 'node-a', { pathLang: Language.en });

      expect(result.breadcrumbPath).toEqual([
        { name: 'Name C', slug: 'slug-c' },
        { name: 'Name B', slug: 'slug-b' },
      ]);
      expect(counter.reads()).toBeLessThanOrEqual(3);
    });

    it('здоровое дерево: крошки идут от корня к узлу, перевода нет — берётся базовое имя', async () => {
      wireTree([cat('A', 'M'), cat('M', 'R'), cat('R', null)], 'A', [
        trans('A', 'Node A', 'node-a'),
        trans('R', 'Root EN', 'root-en'),
      ]);

      const result = await service.resolvePublic('category', 'node-a', { pathLang: Language.en });

      expect(result.breadcrumbPath).toEqual([
        { name: 'Root EN', slug: 'root-en' },
        { name: 'Name M', slug: 'slug-m' },
      ]);
    });

    it('переводы предков берутся одним запросом, а не по запросу на уровень', async () => {
      wireTree([cat('A', 'M'), cat('M', 'R'), cat('R', null)], 'A', [
        trans('A', 'Node A', 'node-a'),
        trans('R', 'Root EN', 'root-en'),
      ]);

      await service.resolvePublic('category', 'node-a', { pathLang: Language.en });

      const batchCalls = prisma.categoryTranslation.findMany.mock.calls.filter(
        (call) => typeof (call[0] as TransFindManyArgs).where.categoryId === 'object',
      );
      expect(batchCalls).toHaveLength(1);
      expect(prisma.categoryTranslation.findUnique).not.toHaveBeenCalled();
    });

    describe('страница книги', () => {
      const wireBook = (primaryCategoryId: string) => {
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
            coverImageUrl: null,
            seoId: null,
            slug: 'book-slug',
            status: 'published',
            type: 'text',
            primaryCategoryId,
          },
        ]);
      };

      it('своя категория книги остаётся последней крошкой', async () => {
        wireBook('A');
        wireTree([cat('A', 'R'), cat('R', null)], 'A', [trans('R', 'Root EN', 'root-en')]);

        const result = await service.resolvePublic('book', 'book-slug', { pathLang: Language.en });

        expect(result.breadcrumbPath).toEqual([
          { name: 'Root EN', slug: 'root-en', type: 'category' },
          { name: 'Name A', slug: 'slug-a', type: 'category' },
        ]);
      });

      it('замкнутое дерево не вешает страницу книги', async () => {
        wireBook('A');
        const counter = wireTree([cat('A', 'B'), cat('B', 'A')], 'A', []);

        const result = await service.resolvePublic('book', 'book-slug', { pathLang: Language.en });

        expect(result.breadcrumbPath).toEqual([
          { name: 'Name B', slug: 'slug-b', type: 'category' },
          { name: 'Name A', slug: 'slug-a', type: 'category' },
        ]);
        // Одно чтение самой категории книги плюс одно на единственного предка.
        expect(counter.reads()).toBeLessThanOrEqual(3);
      });
    });
  });
});
