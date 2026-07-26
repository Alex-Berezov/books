import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Language, BookType, Prisma, BookVersion, Seo } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';

type SeoFragment = Pick<Seo, 'metaTitle' | 'metaDescription'>;
type BookVersionWithSeo = BookVersion & { seo?: SeoFragment | null };

interface PrismaStub {
  book: {
    findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<{
      id: string;
      rightsIntakeId: string | null;
      currentRightsProfileId: string | null;
      approvedRightsReviewId: string | null;
    } | null>;
  };
  rightsIntake: {
    findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<{
      id: string;
      targetLanguages: string[];
    } | null>;
  };
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
  bookCategory: {
    createMany: (args: {
      data: Array<{ id: string; bookVersionId: string; categoryId: string }>;
    }) => Promise<{ count: number }>;
    findMany: (args: {
      where: { bookVersionId: string };
      select: { categoryId: boolean };
    }) => Promise<Array<{ categoryId: string }>>;
  };
  bookTag: {
    createMany: (args: {
      data: Array<{ id: string; bookVersionId: string; tagId: string }>;
    }) => Promise<{ count: number }>;
    findMany: (args: {
      where: { bookVersionId: string };
      select: { tagId: boolean };
    }) => Promise<Array<{ tagId: string }>>;
  };
  $transaction: <T>(fn: (tx: PrismaStub) => Promise<T> | T) => Promise<T>;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    book: {
      findUnique: jest.fn(),
    },
    rightsIntake: {
      findUnique: jest.fn(),
    },
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
    bookCategory: {
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    bookTag: {
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: async <T>(fn: (tx: PrismaStub) => Promise<T> | T) => fn(stub),
  } as unknown as PrismaStub;
  return stub;
};

describe('BookVersionService', () => {
  let service: BookVersionService;
  let prisma: PrismaStub;
  let gateService: jest.Mocked<
    Pick<PublicationGateService, 'assertVersionCanPublish' | 'checkVersionCanPublish'>
  >;
  let mockRightsContentHashService: jest.Mocked<RightsContentHashService>;

  beforeEach(() => {
    prisma = createPrismaStub();
    gateService = {
      assertVersionCanPublish: jest.fn().mockResolvedValue(undefined),
      checkVersionCanPublish: jest.fn(),
    };
    mockRightsContentHashService = {
      computeVersionHash: jest.fn(),
      initializeVersionBaseline: jest.fn(),
      checkVersionStaleness: jest.fn(),
      markVersionAndClearanceStale: jest.fn(),
    } as unknown as jest.Mocked<RightsContentHashService>;
    service = new BookVersionService(
      prisma as unknown as PrismaService,
      gateService as unknown as PublicationGateService,
      mockRightsContentHashService,
    );
  });

  it('creates version with seo', async () => {
    (prisma.book.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      rightsIntakeId: 'intake-1',
      currentRightsProfileId: 'profile-1',
      approvedRightsReviewId: 'review-1',
    });
    (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
      id: 'intake-1',
      targetLanguages: ['en', 'es'],
    });
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
    (prisma.book.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      rightsIntakeId: 'intake-1',
    });
    (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
      id: 'intake-1',
      targetLanguages: ['en', 'es'],
    });
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
    (prisma.book.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      rightsIntakeId: 'intake-1',
      currentRightsProfileId: 'profile-1',
      approvedRightsReviewId: 'review-1',
    });
    (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
      id: 'intake-1',
      targetLanguages: ['en', 'es'],
    });
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

  it('list applies Accept-Language when language not specified', async () => {
    const now = new Date();
    (prisma.bookVersion.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: 'v-en',
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
        status: 'published',
        publishedAt: now,
      },
      {
        id: 'v-es',
        bookId: 'b1',
        language: Language.es,
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
        status: 'published',
        publishedAt: now,
      },
    ]);

    const list = await service.list('b1', {}, 'es, fr;q=0.8');
    expect(list).toHaveLength(1);
    expect(list[0].language).toBe(Language.es);
  });

  it('getPublic throws NotFound for draft', async () => {
    (prisma.bookVersion.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.getPublic('v-draft')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('publish calls publication gate and unpublish does not', async () => {
    const now = new Date();
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({ id: 'v1' } as any);
    (prisma.bookVersion.update as jest.Mock)
      .mockResolvedValueOnce({ id: 'v1', status: 'published', publishedAt: now } as any)
      .mockResolvedValueOnce({ id: 'v1', status: 'draft', publishedAt: null } as any);

    const pub = await service.publish('v1');
    expect(pub.status).toBe('published');
    expect(gateService.assertVersionCanPublish).toHaveBeenCalledWith('v1');

    const unpub = await service.unpublish('v1');
    expect(unpub.status).toBe('draft');
    // unpublish should NOT call publication gate
    expect(gateService.assertVersionCanPublish).toHaveBeenCalledTimes(1);
  });

  it('publish throws if gate blocks', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({ id: 'v1' } as any);
    gateService.assertVersionCanPublish.mockRejectedValue(
      new BadRequestException({
        message: 'Publication blocked by rights gate',
        code: 'RIGHTS_PUBLICATION_BLOCKED',
        canPublish: false,
        blockingReasons: [
          { code: 'MISSING_RIGHTS_PROFILE', severity: 'BLOCKER', messageRu: 'test' },
        ],
        warnings: [],
      }),
    );

    await expect(service.publish('v1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.bookVersion.update).not.toHaveBeenCalled();
  });

  it('listAdmin ignores status filter (returns drafts too)', async () => {
    const now = new Date();
    (prisma.bookVersion.findMany as jest.Mock).mockResolvedValue([
      { id: 'v-pub', status: 'published', createdAt: now, updatedAt: now } as any,
      { id: 'v-draft', status: 'draft', createdAt: now, updatedAt: now } as any,
    ]);
    const res = await service.listAdmin('b1', {});
    expect(res.map((r) => r.id)).toEqual(['v-pub', 'v-draft']);
  });

  it('copies categories and tags from sibling version if exists', async () => {
    (prisma.book.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      rightsIntakeId: 'intake-1',
      currentRightsProfileId: 'profile-1',
      approvedRightsReviewId: 'review-1',
    });
    (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
      id: 'intake-1',
      targetLanguages: ['en', 'es'],
    });

    const mockFindFirst = prisma.bookVersion.findFirst as jest.Mock;
    mockFindFirst
      .mockResolvedValueOnce(null) // for duplicate check
      .mockResolvedValueOnce({
        id: 'sibling-v',
        primaryCategoryId: 'cat-sibling',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        rightsStatus: 'APPROVED',
        rightsAllowedCountryCodes: ['US'],
        rightsBlockedCountryCodes: [],
        rightsLicenseRequiredCountryCodes: [],
        rightsPendingCountryCodes: [],
        rightsRequiredActions: [],
        rightsGeoBlockRequired: false,
        rightsGeoBlockConfigured: false,
        rightsGeoBlockConfiguredAt: null,
        rightsGeoBlockNotesRu: null,
      });

    (prisma.bookCategory.findMany as jest.Mock).mockResolvedValue([{ categoryId: 'cat1' }]);
    (prisma.bookTag.findMany as jest.Mock).mockResolvedValue([{ tagId: 'tag1' }]);

    const now = new Date();
    (prisma.bookVersion.create as jest.Mock).mockResolvedValue({
      id: 'new-v',
      bookId: 'b1',
      language: Language.es,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      createdAt: now,
      updatedAt: now,
      primaryCategoryId: 'cat-sibling',
    });

    const dto: CreateBookVersionDto = {
      language: Language.es,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
    };

    const res = await service.create('b1', dto);

    expect(res.id).toBe('new-v');
    expect(res.primaryCategoryId).toBe('cat-sibling');
    expect(prisma.bookCategory.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            bookVersionId: 'new-v',
            categoryId: 'cat1',
          }),
        ]),
      }),
    );
    expect(prisma.bookTag.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            bookVersionId: 'new-v',
            tagId: 'tag1',
          }),
        ]),
      }),
    );
  });

  describe('getRightsDashboard', () => {
    it('throws NotFoundException when version does not exist', async () => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.getRightsDashboard('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns dashboard for version without clearance', async () => {
      const mockVersion = {
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        type: 'text',
        status: 'draft',
        title: 'Title',
        rightsProfileId: null,
        approvedRightsReviewId: null,
        rightsStatus: null,
        rightsGeoBlockRequired: false,
        rightsGeoBlockConfigured: false,
        rightsGeoBlockConfiguredAt: null,
        rightsGeoBlockNotesRu: null,
        rightsContentHash: null,
        rightsContentHashAlgorithmVersion: null,
        rightsContentHashCalculatedAt: null,
        rightsRecheckRequired: false,
        rightsStaleDetectedAt: null,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
        book: {
          id: 'b1',
          slug: 'slug-b1',
          rightsIntakeId: null,
          currentRightsProfileId: null,
          approvedRightsReviewId: null,
          rightsCreatedAt: null,
        },
      };

      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(mockVersion);
      (prisma.bookVersion.findMany as jest.Mock).mockResolvedValue([mockVersion]);
      (gateService.checkVersionCanPublish as jest.Mock).mockResolvedValue({
        canPublish: false,
        blockingReasons: [{ code: 'NO_CLEARANCE', messageRu: 'No clearance' }],
        warnings: [],
      });
      (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mockResolvedValue({
        matchesBaseline: false,
        recheckRequired: false,
      });

      const res = await service.getRightsDashboard('v1');
      expect(res.book.id).toBe('b1');
      expect(res.currentVersion.id).toBe('v1');
      expect(res.summary.hasClearance).toBe(false);
      expect(res.summary.canPublishCurrentVersion).toBe(false);
      expect(res.summary.publicationGate).toBe('BLOCK');
    });
  });
});
