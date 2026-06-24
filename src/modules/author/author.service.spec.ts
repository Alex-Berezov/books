import { AuthorService } from './author.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Language } from '@prisma/client';

interface PrismaStub {
  author: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
  };
  authorTranslation: {
    deleteMany: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    findFirst: jest.Mock;
  };
  seo: {
    deleteMany: jest.Mock;
  };
  bookVersion: {
    findMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    author: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    authorTranslation: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    seo: {
      deleteMany: jest.fn(),
    },
    bookVersion: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  stub.$transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback === 'function') {
      const fn = callback as (tx: Omit<PrismaStub, '$transaction'>) => Promise<unknown>;
      return fn(stub);
    }
    return callback;
  });

  return stub;
};

describe('AuthorService', () => {
  let service: AuthorService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new AuthorService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('creates author successfully', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.create.mockResolvedValue({ id: 'auth1', translations: [] });

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      const result = await service.create(dto);
      expect(prisma.authorTranslation.findFirst).toHaveBeenCalledWith({
        where: { language: Language.en, slug: 'oscar-wilde' },
      });
      expect(prisma.author.create).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('throws BadRequestException if translation slug exists', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue({ id: 'trans1', slug: 'oscar-wilde' });

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('updates author successfully', async () => {
      prisma.author.findUnique.mockResolvedValue({ id: 'auth1' }); // findUnique check in service
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.author.update.mockResolvedValue({ id: 'auth1' });
      prisma.authorTranslation.findMany.mockResolvedValue([]);

      const dto = {
        translations: [{ language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' }],
      };

      const result = await service.update('auth1', dto);
      expect(result).toBeDefined();
    });

    it('throws NotFoundException if author does not exist', async () => {
      prisma.author.findUnique.mockResolvedValue(null);

      await expect(service.update('auth1', { translations: [] })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('deletes author successfully', async () => {
      prisma.author.findUnique.mockResolvedValue({ id: 'auth1' });
      prisma.author.delete.mockResolvedValue({ id: 'auth1' });

      await service.delete('auth1');
      expect(prisma.author.delete).toHaveBeenCalledWith({ where: { id: 'auth1' } });
    });

    it('throws NotFoundException on delete if not found', async () => {
      prisma.author.findUnique.mockResolvedValue(null);

      await expect(service.delete('auth1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getPublicBySlug', () => {
    it('returns author public view data with translated books', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue({
        id: 'trans1',
        authorId: 'auth1',
        slug: 'oscar-wilde',
        language: Language.en,
        name: 'Oscar Wilde',
        biography: 'Bio text',
        quotes: [],
        faq: [],
        similarSlugs: [],
        author: {
          id: 'auth1',
          birthDate: '1854-10-16',
          deathDate: '1900-11-30',
        },
      });

      prisma.bookVersion.findMany.mockResolvedValue([
        {
          id: 'v1',
          bookId: 'b1',
          slug: 'picture-of-dorian-gray',
          title: 'The Picture of Dorian Gray',
          author: 'Oscar Wilde',
          coverImageUrl: 'cover.jpg',
          type: 'text',
          isFree: true,
          language: Language.en,
          status: 'published',
          book: { id: 'b1', slug: 'dorian-gray' },
        },
      ]);

      const result = await service.getPublicBySlug('oscar-wilde', Language.en);
      expect(result.name).toBe('Oscar Wilde');
      expect(result.books).toHaveLength(1);
      expect(result.books[0].title).toBe('The Picture of Dorian Gray');
    });

    it('throws NotFoundException if no translation is found by slug', async () => {
      prisma.authorTranslation.findFirst.mockResolvedValue(null);

      await expect(service.getPublicBySlug('oscar-wilde', Language.en)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
