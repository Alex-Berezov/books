import { CategoryService } from './category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { BadRequestException } from '@nestjs/common';
import { Language } from '@prisma/client';

interface PrismaStub {
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
  category: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
  };
  categoryTranslation: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  bookVersion: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  bookCategory: {
    findFirst: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
  bookRating: {
    groupBy: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  category: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
  categoryTranslation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  bookVersion: { findUnique: jest.fn(), findMany: jest.fn() },
  bookCategory: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
  bookRating: { groupBy: jest.fn() },
});

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: PrismaStub;
  let indexability: { recomputeForTerms: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (tx: PrismaStub) => unknown) => cb(prisma as unknown as PrismaStub));
    indexability = { recomputeForTerms: jest.fn().mockResolvedValue(undefined) };
    service = new CategoryService(
      prisma as unknown as PrismaService,
      {
        record: jest.fn().mockResolvedValue(undefined),
        resolve: jest.fn().mockResolvedValue(null),
      } as unknown as SlugRedirectService,
      indexability as unknown as TaxonomyIndexabilityService,
    );
  });

  it('update rejects cycle in hierarchy', async () => {
    // Graph: A <- C <- B; set parent(A) = B -> cycle
    const parentMap: Record<string, string | null> = { A: null, B: 'C', C: 'A' };
    prisma.category.findUnique.mockImplementation(
      (args: { where: { id: string }; select?: { parentId?: boolean } }) => {
        const id: string = args.where.id;
        if (args.select && 'parentId' in args.select) {
          return { parentId: parentMap[id] ?? null };
        }
        return {
          id,
          name: 'X',
          slug: 'x',
          type: 'genre',
          parentId: parentMap[id] ?? null,
        };
      },
    );

    await expect(service.update('A', { parentId: 'B' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('remove rejects when category has children', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'A' });
    prisma.category.count.mockResolvedValue(1);
    await expect(service.remove('A')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getBySlugWithBooks filters versions by effective language and falls back to base slug', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue(null);
    prisma.category.findFirst.mockResolvedValue({ id: 'cat1', name: 'Cat', slug: 'cat' });
    const now = new Date();

    (prisma as any).book = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'b1',
          slug: 'b1',
          createdAt: now,
          updatedAt: now,
          versions: [
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
          ],
        },
        {
          id: 'b2',
          slug: 'b2',
          createdAt: now,
          updatedAt: now,
          versions: [
            {
              id: 'v-en',
              bookId: 'b2',
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
          ],
        },
      ]),
    };
    prisma.bookVersion.findMany.mockResolvedValue([
      { language: Language.en },
      { language: Language.es },
    ]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    const res = await service.getBySlugWithBooks('cat', undefined, 'es, en;q=0.8');
    expect(res.availableLanguages.sort()).toEqual([Language.en, Language.es].sort());
    expect(res.data).toHaveLength(1);
    expect(res.data[0].versions[0].language).toBe(Language.es);
    expect(res.category.translation).toBeNull();
  });

  it('list exposes per-translation indexability (source of truth for the sitemap)', async () => {
    prisma.$transaction = jest
      .fn()
      .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
    prisma.category.count.mockResolvedValue(1);
    prisma.category.findMany.mockResolvedValue([
      {
        id: 'c1',
        name: 'Poetry',
        slug: 'poetry',
        key: 'poetry',
        type: 'genre',
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [
          {
            language: Language.ru,
            name: 'Поэзия',
            slug: 'poeziya',
            bookCount: 1,
            autoIndexable: false,
          },
        ],
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ categoryId: 'c1', booksCount: 1 }]);

    const res = await service.list(1, 20, 'genre', Language.ru);

    expect(res.data[0].translations[0]).toEqual(
      expect.objectContaining({ bookCount: 1, autoIndexable: false }),
    );
    expect(res.data[0].autoIndexable).toBe(false);
    expect(res.data[0].langBookCount).toBe(1);
  });

  // LEGACY-117. `Prisma.join([])` бросает TypeError на сборке условия, и публичный
  // список уходил в 500 на пустой выборке. Проверяется именно **отсутствие вызова**
  // `$queryRaw`: код, который зовёт raw и глотает исключение, тоже вернёт пустой
  // список.
  it('list returns an empty page without touching $queryRaw when the page is out of range', async () => {
    prisma.$transaction = jest
      .fn()
      .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
    prisma.category.count.mockResolvedValue(42);
    prisma.category.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockRejectedValue(new Error('$queryRaw must not be reached'));

    const res = await service.list(99, 20, 'genre', Language.ru);

    expect(res.data).toEqual([]);
    expect(res.meta).toEqual({ page: 99, limit: 20, total: 42, totalPages: 3 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  describe('getTree projects per-language indexability', () => {
    beforeEach(() => {
      prisma.category.findMany.mockResolvedValue([
        {
          id: 'c1',
          name: 'Historical Fiction',
          slug: 'historical-fiction',
          key: 'historical-fiction',
          type: 'genre',
          parentId: null,
          indexable: true,
          isVisible: true,
          sortOrder: 0,
          translations: [
            {
              language: Language.en,
              name: 'Historical Fiction',
              slug: 'historical-fiction',
              bookCount: 7,
              autoIndexable: true,
            },
            {
              language: Language.ru,
              name: 'Исторический роман',
              slug: 'istoricheskiy-roman',
              bookCount: 1,
              autoIndexable: false,
            },
          ],
        },
        {
          id: 'c2',
          name: 'Poetry',
          slug: 'poetry',
          key: 'poetry',
          type: 'genre',
          parentId: null,
          indexable: true,
          isVisible: true,
          sortOrder: 1,
          translations: [
            {
              language: Language.en,
              name: 'Poetry',
              slug: 'poetry',
              bookCount: 9,
              autoIndexable: true,
            },
          ],
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ categoryId: 'c1', booksCount: 1 }]);
    });

    it('takes autoIndexable from the requested language, not from another one', async () => {
      const roots = await service.getTree('genre', Language.ru);
      const node = roots.find((n) => n.id === 'c1');

      expect(node?.autoIndexable).toBe(false);
      expect(node?.langBookCount).toBe(1);
    });

    it('leaves both fields undefined when lang is not passed', async () => {
      const roots = await service.getTree('genre');

      expect(roots[0].autoIndexable).toBeUndefined();
      expect(roots[0].langBookCount).toBeUndefined();
    });

    it('leaves both fields undefined for a term without a translation into lang', async () => {
      const roots = await service.getTree('genre', Language.ru);
      const node = roots.find((n) => n.id === 'c2');

      expect(node?.autoIndexable).toBeUndefined();
      expect(node?.langBookCount).toBeUndefined();
    });

    it('keeps booksCount live and exposes per-translation indexability', async () => {
      const roots = await service.getTree('genre', Language.ru);
      const node = roots.find((n) => n.id === 'c1');

      expect(node?.booksCount).toBe(1);
      // The sitemap picks a translation by language and needs the same signal there.
      expect(node?.translations).toEqual([
        expect.objectContaining({ language: Language.en, bookCount: 7, autoIndexable: true }),
        expect.objectContaining({ language: Language.ru, bookCount: 1, autoIndexable: false }),
      ]);
    });
  });

  it('detachCategoryFromVersion is idempotent when relation missing', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    const res = await service.detachCategoryFromVersion('v1', 'c1');
    expect(res).toEqual({ success: true });
  });

  it('detaching a category recomputes that term, not the version', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);

    await service.detachCategoryFromVersion('v1', 'c1');

    // After the delete the version no longer points at the term, so only an
    // explicit term-scoped recompute can still reach it.
    expect(indexability.recomputeForTerms).toHaveBeenCalledWith(['c1'], []);
  });

  it('attaching a category recomputes that term', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.bookCategory.findFirst.mockResolvedValue(null);

    await service.attachCategoryToVersion('v1', 'c1');

    expect(indexability.recomputeForTerms).toHaveBeenCalledWith(['c1'], []);
  });

  it('creates a translation that is not indexable until it earns it', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    prisma.categoryTranslation.create.mockResolvedValue({ id: 'tr1' });

    await service.createTranslation('c1', {
      language: Language.en,
      name: 'Poetry',
      slug: 'poetry',
    });

    expect(prisma.categoryTranslation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookCount: 0, autoIndexable: false }),
      }),
    );
  });
});
