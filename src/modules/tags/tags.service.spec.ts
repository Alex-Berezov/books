import { TagsService } from './tags.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Language } from '@prisma/client';

interface PrismaStub {
  tag: { findUnique: jest.Mock; findFirst: jest.Mock };
  tagTranslation: { findUnique: jest.Mock };
  bookVersion: { findMany: jest.Mock; findUnique: jest.Mock };
  bookTag: { findFirst: jest.Mock; create: jest.Mock; delete: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  tag: { findUnique: jest.fn(), findFirst: jest.fn() },
  tagTranslation: { findUnique: jest.fn() },
  bookVersion: { findMany: jest.fn(), findUnique: jest.fn() },
  bookTag: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
});

describe('TagsService', () => {
  let service: TagsService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
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

    const res = await service.versionsByTagSlug('tag', undefined, 'es, en;q=0.8');
    expect(res.availableLanguages.sort()).toEqual([Language.en, Language.es].sort());
    expect(res.versions).toHaveLength(1);
    expect(res.versions[0].language).toBe(Language.es);
    expect(res.tag.translation).toBeNull();
  });

  it('attach is idempotent and checks existence', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.bookTag.findFirst.mockResolvedValue({ id: 'link1' });
    const res = await service.attach('v1', 't1');
    expect(res).toEqual({ id: 'link1' });
    expect(prisma.bookTag.create).not.toHaveBeenCalled();
  });

  it('detach is idempotent when link absent', async () => {
    prisma.bookTag.findFirst.mockResolvedValue(null);
    const res = await service.detach('v1', 't1');
    expect(res).toEqual({ success: true });
  });
});
