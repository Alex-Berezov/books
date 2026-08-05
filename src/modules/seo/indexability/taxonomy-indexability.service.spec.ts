import { Language } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';

interface PrismaStub {
  bookCategory: { groupBy: jest.Mock; findMany: jest.Mock };
  bookTag: { groupBy: jest.Mock; findMany: jest.Mock };
  categoryTranslation: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  tagTranslation: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  bookVersion: { findUnique: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  bookCategory: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn() },
  bookTag: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn() },
  categoryTranslation: {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  tagTranslation: {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  bookVersion: { findUnique: jest.fn() },
});

describe('TaxonomyIndexabilityService', () => {
  let service: TaxonomyIndexabilityService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new TaxonomyIndexabilityService(prisma as unknown as PrismaService);
  });

  describe('recomputeForTerms', () => {
    it('recomputes the given category in every language, not only one', async () => {
      prisma.categoryTranslation.findMany.mockImplementation(
        (args: { where: { language: Language } }) => [
          {
            id: `tr-${args.where.language}`,
            categoryId: 'c1',
            bookCount: 9,
            autoIndexable: true,
          },
        ],
      );

      await service.recomputeForTerms(['c1'], []);

      // A detached term drops to zero books in each language it was translated into.
      const languages = Object.values(Language);
      expect(prisma.categoryTranslation.findMany).toHaveBeenCalledTimes(languages.length);
      expect(prisma.categoryTranslation.update).toHaveBeenCalledTimes(languages.length);
      expect(prisma.categoryTranslation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { bookCount: 0, autoIndexable: false } }),
      );
    });

    it('scopes the query to the requested terms', async () => {
      await service.recomputeForTerms(['c1', 'c2'], []);

      expect(prisma.categoryTranslation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ categoryId: { in: ['c1', 'c2'] } }),
        }),
      );
    });

    it('does nothing when no term is given', async () => {
      await service.recomputeForTerms([], []);

      expect(prisma.categoryTranslation.findMany).not.toHaveBeenCalled();
      expect(prisma.tagTranslation.findMany).not.toHaveBeenCalled();
    });

    it('never lets a counter failure escape to the caller', async () => {
      prisma.categoryTranslation.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.recomputeForTerms(['c1'], [])).resolves.toBeUndefined();
    });

    it('opens a tag once it reaches the upper threshold', async () => {
      prisma.bookTag.groupBy.mockResolvedValue([{ tagId: 't1', _count: { _all: 5 } }]);
      prisma.tagTranslation.findMany.mockImplementation(
        (args: { where: { language: Language } }) =>
          args.where.language === Language.en
            ? [{ id: 'tr-en', tagId: 't1', bookCount: 0, autoIndexable: false }]
            : [],
      );

      await service.recomputeForTerms([], ['t1']);

      expect(prisma.tagTranslation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tr-en' },
          data: { bookCount: 5, autoIndexable: true },
        }),
      );
    });
  });

  describe('recomputeForBookVersion', () => {
    it('recomputes only the version language', async () => {
      prisma.bookVersion.findUnique.mockResolvedValue({ language: Language.ru });
      prisma.bookCategory.findMany.mockResolvedValue([{ categoryId: 'c1' }]);
      prisma.bookTag.findMany.mockResolvedValue([]);

      await service.recomputeForBookVersion('v1');

      expect(prisma.categoryTranslation.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.categoryTranslation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ language: Language.ru }),
        }),
      );
    });
  });

  describe('recomputeAll cold start', () => {
    it('resets nothing by default', async () => {
      await service.recomputeAll();

      expect(prisma.categoryTranslation.updateMany).not.toHaveBeenCalled();
      expect(prisma.tagTranslation.updateMany).not.toHaveBeenCalled();
    });

    it('resets only tags when only tags were asked for', async () => {
      await service.recomputeAll({ tags: true });

      expect(prisma.categoryTranslation.updateMany).not.toHaveBeenCalled();
      expect(prisma.tagTranslation.updateMany).toHaveBeenCalledWith({
        where: { autoIndexable: true },
        data: { autoIndexable: false },
      });
    });

    it('resets both tables when asked for both', async () => {
      await service.recomputeAll({ categories: true, tags: true });

      expect(prisma.categoryTranslation.updateMany).toHaveBeenCalled();
      expect(prisma.tagTranslation.updateMany).toHaveBeenCalled();
    });

    // The point of the reset: with previous=false the 3-4 band closes instead of
    // inheriting whatever the column happened to hold.
    it('closes a term in the hysteresis band after the reset', async () => {
      prisma.bookTag.groupBy.mockResolvedValue([{ tagId: 't1', _count: { _all: 3 } }]);
      prisma.tagTranslation.findMany.mockImplementation(
        (args: { where: { language: Language } }) =>
          args.where.language === Language.en
            ? [{ id: 'tr-en', tagId: 't1', bookCount: 3, autoIndexable: false }]
            : [],
      );

      await service.recomputeAll({ tags: true });

      const call = prisma.tagTranslation.update.mock.calls.find(
        (c: [{ where: { id: string } }]) => c[0].where.id === 'tr-en',
      );
      expect(call).toBeUndefined(); // already false and count unchanged → no write
    });
  });
});
