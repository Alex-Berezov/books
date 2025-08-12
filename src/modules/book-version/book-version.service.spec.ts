import { BookVersionService } from './book-version.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Language, BookType, Prisma, BookVersion, Seo } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';

type SeoFragment = Pick<Seo, 'metaTitle' | 'metaDescription'>;
type BookVersionWithSeo = BookVersion & { seo?: SeoFragment | null };

interface PrismaStub {
  bookVersion: {
    findMany: (args?: Prisma.BookVersionFindManyArgs) => Promise<BookVersionWithSeo[]>;
    findFirst: (args?: Prisma.BookVersionFindFirstArgs) => Promise<{ id: string } | null>;
    create: (args: Prisma.BookVersionCreateArgs & { include?: any }) => Promise<BookVersionWithSeo>;
    findUnique: (
      args: Prisma.BookVersionFindUniqueArgs & { include?: any },
    ) => Promise<BookVersionWithSeo | null>;
    update: (args: Prisma.BookVersionUpdateArgs & { include?: any }) => Promise<BookVersionWithSeo>;
    delete: (args: Prisma.BookVersionDeleteArgs & { include?: any }) => Promise<BookVersionWithSeo>;
  };
  seo: {
    create: (
      args: Prisma.SeoCreateArgs,
    ) => Promise<{ id: number; metaTitle: string | null; metaDescription: string | null }>;
    update: (args: Prisma.SeoUpdateArgs) => Promise<{ id: number }>;
  };
  $transaction: <T>(fn: (tx: PrismaStub) => Promise<T> | T) => Promise<T>;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    bookVersion: {
      findMany: jest.fn<Promise<BookVersionWithSeo[]>, [Prisma.BookVersionFindManyArgs?]>(),
      findFirst: jest.fn<Promise<{ id: string } | null>, [Prisma.BookVersionFindFirstArgs?]>(),
      create: jest.fn<
        Promise<BookVersionWithSeo>,
        [Prisma.BookVersionCreateArgs & { include?: any }]
      >(),
      findUnique: jest.fn<
        Promise<BookVersionWithSeo | null>,
        [Prisma.BookVersionFindUniqueArgs & { include?: any }]
      >(),
      update: jest.fn<
        Promise<BookVersionWithSeo>,
        [Prisma.BookVersionUpdateArgs & { include?: any }]
      >(),
      delete: jest.fn<
        Promise<BookVersionWithSeo>,
        [Prisma.BookVersionDeleteArgs & { include?: any }]
      >(),
    },
    seo: {
      create: jest.fn<
        Promise<{ id: number; metaTitle: string | null; metaDescription: string | null }>,
        [Prisma.SeoCreateArgs]
      >(),
      update: jest.fn<Promise<{ id: number }>, [Prisma.SeoUpdateArgs]>(),
    },
    $transaction: async <T>(fn: (tx: PrismaStub) => Promise<T> | T) => fn(stub),
  } as PrismaStub;
  return stub;
};

describe('BookVersionService', () => {
  let service: BookVersionService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    // Narrow stub to PrismaService for constructor (safe: tests only use mocked methods)
    service = new BookVersionService(prisma as unknown as PrismaService);
  });

  it('creates version with seo', async () => {
    (prisma.bookVersion.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.seo.create as jest.Mock).mockResolvedValue({
      id: 10,
      metaTitle: 'MT',
      metaDescription: 'MD',
    });
    const now = new Date();
    (prisma.bookVersion.create as jest.Mock).mockResolvedValue({
      id: 'v1',
      bookId: 'b1',
      language: Language.en,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: 10,
      seo: { metaTitle: 'MT', metaDescription: 'MD' },
    });
    const dto: CreateBookVersionDto = {
      language: Language.en,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      seoMetaTitle: 'MT',
      seoMetaDescription: 'MD',
    };
    const res = await service.create('b1', dto);
    expect(res.seo?.metaTitle).toBe('MT');
    expect(prisma.bookVersion.create).toHaveBeenCalled();
  });

  it('rejects duplicate language per book', async () => {
    (prisma.bookVersion.findFirst as jest.Mock).mockResolvedValue({ id: 'existing' });
    const dto: CreateBookVersionDto = {
      language: Language.en,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
    };
    await expect(service.create('b1', dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates version and updates existing seo', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'v1',
      seoId: 10,
    } as BookVersion);
    (prisma.seo.update as jest.Mock).mockResolvedValue({ id: 10 });
    const now = new Date();
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      bookId: 'b1',
      language: Language.en,
      title: 'T2',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: 10,
      seo: { metaTitle: 'New', metaDescription: null },
    });
    const updateDto: UpdateBookVersionDto = { title: 'T2', seoMetaTitle: 'New' };
    const res = await service.update('v1', updateDto);
    expect(res.title).toBe('T2');
    expect(prisma.seo.update).toHaveBeenCalled();
  });

  it('throws NotFound on update missing', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(null);
    const updateDto: UpdateBookVersionDto = { title: 'X' };
    await expect(service.update('missing', updateDto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates version without seo fragment', async () => {
    (prisma.bookVersion.findFirst as jest.Mock).mockResolvedValue(null);
    const now = new Date();
    (prisma.bookVersion.create as jest.Mock).mockResolvedValue({
      id: 'v2',
      bookId: 'b1',
      language: Language.es,
      title: 'R',
      author: 'A',
      description: 'DR',
      coverImageUrl: 'u2',
      type: BookType.text,
      isFree: false,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: undefined,
      seo: null,
    });
    const dto: CreateBookVersionDto = {
      language: Language.es,
      title: 'R',
      author: 'A',
      description: 'DR',
      coverImageUrl: 'u2',
      type: BookType.text,
      isFree: false,
    };
    const res = await service.create('b1', dto);
    expect(res.seo).toBeNull();
    expect(prisma.seo.create).not.toHaveBeenCalled();
  });

  it('removes version', async () => {
    const now = new Date();
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v3',
      bookId: 'b1',
      language: Language.en,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: undefined,
    });
    (prisma.bookVersion.delete as jest.Mock).mockResolvedValue({
      id: 'v3',
      bookId: 'b1',
      language: Language.en,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: undefined,
      seo: null,
    });
    const res = await service.remove('v3');
    expect(res.id).toBe('v3');
    expect(prisma.bookVersion.delete).toHaveBeenCalled();
  });
});
