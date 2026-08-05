import { TagsService } from './tags.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language } from '@prisma/client';

interface PrismaStub {
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
  tag: { findUnique: jest.Mock; findFirst: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  tagTranslation: { findUnique: jest.Mock };
  bookVersion: { findMany: jest.Mock; findUnique: jest.Mock };
  bookTag: { findFirst: jest.Mock; create: jest.Mock; delete: jest.Mock };
  bookRating: { groupBy: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  tag: { findUnique: jest.fn(), findFirst: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  tagTranslation: { findUnique: jest.fn() },
  bookVersion: { findMany: jest.fn(), findUnique: jest.fn() },
  bookTag: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
  bookRating: { groupBy: jest.fn() },
});

describe('TagsService', () => {
  let service: TagsService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (tx: PrismaStub) => unknown) => cb(prisma as unknown as PrismaStub));
    service = new TagsService(prisma as unknown as PrismaService);
  });

  it('versionsByTagSlug filters by effective language and falls back to base slug', async () => {
    prisma.tagTranslation.findUnique.mockResolvedValue(null);
    prisma.tag.findFirst.mockResolvedValue({ id: 't1', name: 'Tag', slug: 'tag' });
    const now = new Date();
    prisma.bookVersion.findMany.mockResolvedValue([
      {
        id: 'v-en',
        bookId: 'b1',
        language: Language.en,
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'u',
        type: 'text',
        isFree: true,
        referralUrl: null,
        createdAt: now,
        updatedAt: now,
        status: 'published',
        publishedAt: now,
        seoId: undefined,
        seo: null,
      },
      {
        id: 'v-es',
        bookId: 'b1',
        language: Language.es,
        title: 'T2',
        author: 'A',
        description: 'D',
        coverImageUrl: 'u',
        type: 'text',
        isFree: true,
        referralUrl: null,
        createdAt: now,
        updatedAt: now,
        status: 'published',
        publishedAt: now,
        seoId: undefined,
        seo: null,
      },
    ]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    const res = await service.versionsByTagSlug('tag', undefined, 'es, en;q=0.8');
    expect(res.availableLanguages.sort()).toEqual([Language.en, Language.es].sort());
    expect(res.versions).toHaveLength(1);
    expect(res.versions[0].language).toBe(Language.es);
    expect(res.tag.translation).toBeNull();
  });

  describe('list projects per-language indexability', () => {
    const translation = (
      language: Language,
      slug: string,
      bookCount: number,
      autoIndexable: boolean,
    ) => ({
      language,
      name: slug,
      slug,
      description: null,
      relatedTagSlugs: null,
      relatedGenreSlugs: null,
      relatedCategorySlugs: null,
      relatedCollectionSlugs: null,
      bookCount,
      autoIndexable,
    });

    beforeEach(() => {
      prisma.$transaction = jest
        .fn()
        .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.tag.count.mockResolvedValue(2);
      prisma.tag.findMany.mockResolvedValue([
        {
          id: 't1',
          name: 'Adventure',
          slug: 'adventure',
          key: 'adventure',
          indexable: true,
          isVisible: true,
          sortOrder: 0,
          translations: [
            translation(Language.en, 'adventure', 7, true),
            translation(Language.es, 'aventura', 2, false),
          ],
        },
        {
          id: 't2',
          name: 'Poetry',
          slug: 'poetry',
          key: 'poetry',
          indexable: true,
          isVisible: true,
          sortOrder: 1,
          translations: [translation(Language.en, 'poetry', 9, true)],
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ tagId: 't1', booksCount: 2 }]);
    });

    it('takes autoIndexable from the requested language, not from another one', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't1');

      expect(tag?.autoIndexable).toBe(false);
      expect(tag?.langBookCount).toBe(2);
    });

    it('leaves both fields undefined when lang is not passed', async () => {
      const res = await service.list(1, 20);

      expect(res.data[0].autoIndexable).toBeUndefined();
      expect(res.data[0].langBookCount).toBeUndefined();
    });

    it('leaves both fields undefined for a tag without a translation into lang', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't2');

      expect(tag?.autoIndexable).toBeUndefined();
      expect(tag?.langBookCount).toBeUndefined();
    });

    it('keeps booksCount live and exposes per-translation indexability', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't1');

      expect(tag?.booksCount).toBe(2);
      // The sitemap picks a translation by language and needs the same signal there.
      expect(tag?.translations).toEqual([
        expect.objectContaining({ language: Language.en, bookCount: 7, autoIndexable: true }),
        expect.objectContaining({ language: Language.es, bookCount: 2, autoIndexable: false }),
      ]);
    });
  });

  it('attach is idempotent and checks existence', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.bookTag.findFirst.mockResolvedValue({ id: 'link1' });
    const res = await service.attach('v1', 't1');
    expect(res).toEqual({ id: 'link1' });
    expect(prisma.bookTag.create).not.toHaveBeenCalled();
  });

  it('detach is idempotent when link absent', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    const res = await service.detach('v1', 't1');
    expect(res).toEqual({ success: true });
  });
});
