import { BookService } from './book.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BookType, Language } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

interface PrismaStub {
  book: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  bookVersion: { findMany: jest.Mock; findFirst: jest.Mock; groupBy: jest.Mock };
  bookSummary: { findFirst: jest.Mock };
  seo: { findUnique: jest.Mock };
  bookCategory: { findMany: jest.Mock };
  bookTag: { findMany: jest.Mock };
  bookRating: {
    aggregate: jest.Mock;
    upsert: jest.Mock;
    findUnique: jest.Mock;
    groupBy: jest.Mock;
  };
  authorTranslation: { findMany: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  book: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  bookVersion: {
    findMany: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
    groupBy: jest.fn(),
  },
  bookSummary: { findFirst: jest.fn() },
  seo: { findUnique: jest.fn() },
  bookCategory: { findMany: jest.fn().mockResolvedValue([]) },
  bookTag: { findMany: jest.fn().mockResolvedValue([]) },
  bookRating: {
    aggregate: jest.fn().mockResolvedValue({ _avg: { score: 5.0 } }),
    upsert: jest.fn(),
    findUnique: jest.fn(),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  authorTranslation: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('BookService.getOverview', () => {
  let service: BookService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new BookService(prisma as unknown as PrismaService);
  });

  it('returns aggregated overview with languages, flags and SEO (happy path)', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b1', slug: 'slug-1' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-en',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 5, audioChapters: 0, summaries: 1 },
      },
      {
        id: 'v-audio-es',
        language: Language.es,
        type: BookType.audio,
        isFree: false,
        seoId: 2,
        _count: { chapters: 0, audioChapters: 3, summaries: 0 },
      },
      {
        id: 'v-ref-fr',
        language: Language.fr,
        type: BookType.referral,
        isFree: true,
        seoId: null,
        _count: { chapters: 0, audioChapters: 0, summaries: 0 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1' });
    prisma.seo.findUnique.mockImplementation((args: { where: { id: number } }) => {
      if (args?.where?.id === 1)
        return Promise.resolve({ metaTitle: 'T-text', metaDescription: 'D-text' });
      if (args?.where?.id === 2)
        return Promise.resolve({ metaTitle: 'T-audio', metaDescription: 'D-audio' });
      return Promise.resolve(null);
    });

    const res = await service.getOverview('slug-1', undefined, 'es');

    expect(res.book.slug).toBe('slug-1');
    expect(new Set(res.availableLanguages)).toEqual(
      new Set([Language.en, Language.es, Language.fr]),
    );
    expect(res.hasText).toBe(true);
    expect(res.hasAudio).toBe(true);
    expect(res.hasSummary).toBe(true);
    expect(res.versionIds).toEqual({ text: 'v-text-en', audio: 'v-audio-es' });
    expect(res.seo.main?.metaTitle).toBe('T-text');
    expect(res.seo.read?.metaTitle).toBe('T-text');
    expect(res.seo.listen?.metaTitle).toBe('T-audio');
    expect(res.seo.summary?.metaTitle).toBe('T-text');
  });

  it('handles no versions gracefully', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b2', slug: 'book-2' });
    prisma.bookVersion.findMany.mockResolvedValue([]);

    const res = await service.getOverview('book-2');
    expect(res.availableLanguages).toEqual([]);
    expect(res.hasText).toBe(false);
    expect(res.hasAudio).toBe(false);
    expect(res.hasSummary).toBe(false);
    expect(res.versionIds).toEqual({ text: null, audio: null });
    expect(res.seo.main).toBeNull();
  });

  it('prefers same-language version when available', async () => {
    prisma.book.findUnique.mockResolvedValue({ id: 'b3', slug: 'book-3' });
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-text-en',
        language: Language.en,
        type: BookType.text,
        isFree: true,
        seoId: 1,
        _count: { chapters: 3, audioChapters: 0, summaries: 1 },
      },
      {
        id: 'v-text-es',
        language: Language.es,
        type: BookType.text,
        isFree: true,
        seoId: 2,
        _count: { chapters: 4, audioChapters: 0, summaries: 1 },
      },
    ]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's2' });
    prisma.seo.findUnique.mockResolvedValue({
      metaTitle: 'T-any',
      metaDescription: 'D-any',
    });

    const res = await service.getOverview('book-3', 'es');
    expect(res.versionIds.text).toBe('v-text-es');
  });

  describe('rateBook', () => {
    it('throws NotFoundException if book does not exist', async () => {
      prisma.book.findUnique.mockResolvedValue(null);
      await expect(service.rateBook('u1', 'b-none', 5)).rejects.toThrow(NotFoundException);
    });

    it('upserts rating when book exists', async () => {
      prisma.book.findUnique.mockResolvedValue({ id: 'b1' });
      prisma.bookRating.upsert.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        bookId: 'b1',
        score: 5,
      });

      const res = await service.rateBook('u1', 'b1', 5);
      expect(res.score).toBe(5);
      expect(prisma.bookRating.upsert).toHaveBeenCalledWith({
        where: { userId_bookId: { userId: 'u1', bookId: 'b1' } },
        create: { userId: 'u1', bookId: 'b1', score: 5 },
        update: { score: 5 },
      });
    });
  });

  describe('getUserRating', () => {
    it('returns score when rating exists', async () => {
      prisma.bookRating.findUnique.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        bookId: 'b1',
        score: 4,
      });

      const res = await service.getUserRating('u1', 'b1');
      expect(res).toEqual({ score: 4 });
      expect(prisma.bookRating.findUnique).toHaveBeenCalledWith({
        where: { userId_bookId: { userId: 'u1', bookId: 'b1' } },
      });
    });

    it('returns null score when rating does not exist', async () => {
      prisma.bookRating.findUnique.mockResolvedValue(null);

      const res = await service.getUserRating('u1', 'b1');
      expect(res).toEqual({ score: null });
    });
  });

  describe('findAll', () => {
    it('returns list of books with ratings, hasText, hasAudio, hasSummary flags', async () => {
      prisma.book.count.mockResolvedValue(1);
      prisma.book.findMany.mockResolvedValue([
        {
          id: 'b1',
          slug: 'slug-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          versions: [
            {
              id: 'v1',
              language: Language.en,
              type: BookType.text,
              status: 'published',
              _count: { chapters: 5, audioChapters: 2, summaries: 1 },
            },
          ],
        },
      ]);

      const res = await service.findAll({ page: 1, limit: 10 });

      expect(res.meta.total).toBe(1);
      expect(res.data[0].id).toBe('b1');
      expect(res.data[0].hasText).toBe(true);
      expect(res.data[0].hasAudio).toBe(true);
      expect(res.data[0].hasSummary).toBe(true);
    });

    it('sets hasText/hasAudio to false if no chapters or drafts only', async () => {
      prisma.book.count.mockResolvedValue(1);
      prisma.book.findMany.mockResolvedValue([
        {
          id: 'b2',
          slug: 'slug-2',
          createdAt: new Date(),
          updatedAt: new Date(),
          versions: [
            {
              id: 'v2',
              language: Language.en,
              type: BookType.text,
              status: 'draft',
              _count: { chapters: 5, audioChapters: 2, summaries: 1 },
            },
            {
              id: 'v3',
              language: Language.es,
              type: BookType.referral,
              status: 'published',
              _count: { chapters: 0, audioChapters: 0, summaries: 0 },
            },
          ],
        },
      ]);

      const res = await service.findAll({ page: 1, limit: 10 });

      expect(res.data[0].hasText).toBe(false);
      expect(res.data[0].hasAudio).toBe(false);
      expect(res.data[0].hasSummary).toBe(false);
    });
  });

  describe('findCards', () => {
    let service: BookService;
    let prisma: PrismaStub;

    const mockVersion = (overrides: Record<string, unknown> = {}) => ({
      id: (overrides.id as string) ?? 'v1',
      bookId: (overrides.bookId as string) ?? 'b1',
      slug: (overrides.slug as string) ?? 'test-book',
      title: (overrides.title as string) ?? 'Test Book',
      author: (overrides.author as string) ?? 'Test Author',
      authorId: (overrides.authorId as string | null) ?? 'a1',
      coverImageUrl: (overrides.coverImageUrl as string | null) ?? 'https://example.com/cover.jpg',
      type: (overrides.type as BookType) ?? BookType.text,
      publishedAt: (overrides.publishedAt as Date | null) ?? new Date('2024-01-01'),
      language: (overrides.language as Language) ?? Language.en,
      status: (overrides.status as string) ?? 'published',
      _count: {
        chapters: (overrides.chapters as number) ?? 5,
        audioChapters: (overrides.audioChapters as number) ?? 0,
      },
      categories: (overrides.categories as { categoryId: string }[]) ?? [{ categoryId: 'c1' }],
    });

    beforeEach(() => {
      prisma = createPrismaStub();
      service = new BookService(prisma as unknown as PrismaService);
    });

    it('returns paginated compact cards with default sort', async () => {
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([{ id: 'v1', bookId: 'b1' }])
        .mockResolvedValueOnce([mockVersion()])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      prisma.bookVersion.groupBy.mockResolvedValue([{ bookId: 'b1' }]);
      prisma.bookRating.groupBy.mockResolvedValue([]);

      const res = await service.findCards(Language.en);

      expect(res.items).toHaveLength(1);
      expect(res.items[0].title).toBe('Test Book');
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.page).toBe(1);
    });

    it('applies type=audio filter', async () => {
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([{ id: 'v1', bookId: 'b1' }])
        .mockResolvedValueOnce([mockVersion({ audioChapters: 3 })])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      prisma.bookVersion.groupBy.mockResolvedValue([{ bookId: 'b1' }]);
      prisma.bookRating.groupBy.mockResolvedValue([]);

      await service.findCards(Language.en, 1, 24, undefined, 'audio');

      expect(prisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            language: Language.en,
            status: 'published',
            AND: expect.arrayContaining([expect.objectContaining({ audioChapters: { some: {} } })]),
          }),
        }),
      );
    });

    it('applies type=text filter', async () => {
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([{ id: 'v1', bookId: 'b1' }])
        .mockResolvedValueOnce([mockVersion({ chapters: 3 })])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      prisma.bookVersion.groupBy.mockResolvedValue([{ bookId: 'b1' }]);
      prisma.bookRating.groupBy.mockResolvedValue([]);

      await service.findCards(Language.en, 1, 24, undefined, 'text');

      expect(prisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([{ chapters: { some: {} } }, { type: BookType.text }]),
              }),
            ]),
          }),
        }),
      );
    });

    it('applies q search filter', async () => {
      prisma.bookVersion.findMany
        .mockResolvedValueOnce([{ id: 'v1', bookId: 'b1' }])
        .mockResolvedValueOnce([mockVersion({ title: 'Hamlet' })])
        .mockResolvedValueOnce([{ authorId: 'a1', language: 'en', slug: 'test-author' }]);

      prisma.bookVersion.groupBy.mockResolvedValue([{ bookId: 'b1' }]);
      prisma.bookRating.groupBy.mockResolvedValue([]);

      await service.findCards(Language.en, 1, 24, undefined, undefined, 'hamlet');

      expect(prisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  { title: { contains: 'hamlet', mode: 'insensitive' } },
                  { author: { contains: 'hamlet', mode: 'insensitive' } },
                ]),
              }),
            ]),
          }),
        }),
      );
    });

    it('returns empty items when no books match', async () => {
      prisma.bookVersion.findMany.mockResolvedValue([]);
      prisma.bookVersion.groupBy.mockResolvedValue([]);

      const res = await service.findCards(Language.en, 1, 24, undefined, 'audio');

      expect(res.items).toHaveLength(0);
      expect(res.pagination.total).toBe(0);
    });

    it('enforces max limit of 48', async () => {
      prisma.bookVersion.findMany.mockResolvedValue([]);
      prisma.bookVersion.groupBy.mockResolvedValue([]);

      await service.findCards(Language.en, 1, 999);

      expect(prisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 48 }),
      );
    });
  });
});
