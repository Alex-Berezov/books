import { CategoryService } from './category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Language } from '@prisma/client';

interface PrismaStub {
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
    findMany: jest.Mock;
  };
  bookCategory: {
    findFirst: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
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
  bookVersion: { findMany: jest.fn() },
  bookCategory: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
});

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new CategoryService(prisma as unknown as PrismaService);
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

    const res = await service.getBySlugWithBooks('cat', undefined, 'es, en;q=0.8');
    expect(res.availableLanguages.sort()).toEqual([Language.en, Language.es].sort());
    expect(res.versions).toHaveLength(1);
    expect(res.versions[0].language).toBe(Language.es);
    expect(res.category.translation).toBeNull();
  });

  it('detachCategoryFromVersion throws NotFound when relation missing', async () => {
    prisma.bookCategory.findFirst.mockResolvedValue(null);
    await expect(service.detachCategoryFromVersion('v1', 'c1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
