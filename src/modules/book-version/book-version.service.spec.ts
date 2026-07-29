import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { TerritoryRegionAggregationService } from '../rights-intake/territory-region-aggregation.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { RightsRecheckService } from '../rights-recheck/rights-recheck.service';
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
  rightsReviewApproval: {
    findMany: jest.Mock;
  };
  rightsProfile: {
    findUnique: jest.Mock;
  };
  rightsReview: {
    findMany: jest.Mock;
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
    rightsReviewApproval: {
      findMany: jest.fn(),
    },
    rightsProfile: {
      findUnique: jest.fn(),
    },
    rightsReview: {
      findMany: jest.fn(),
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
  let licenseCoverageService: {
    loadLicensesForProfile: jest.Mock;
    effectiveStatus: jest.Mock;
    isActiveAt: jest.Mock;
    evaluateVersionCoverage: jest.Mock;
  };
  let rightsClaimsService: { listForVersion: jest.Mock };
  let rightsRecheckService: {
    ensureTask: jest.Mock;
    getRuntimeConfig: jest.Mock;
    getVersionRecheck: jest.Mock;
  };

  beforeEach(() => {
    prisma = createPrismaStub();
    rightsClaimsService = {
      listForVersion: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 0 }),
    };
    licenseCoverageService = {
      loadLicensesForProfile: jest.fn().mockResolvedValue([]),
      effectiveStatus: jest.fn().mockReturnValue('ACTIVE'),
      isActiveAt: jest.fn().mockReturnValue(true),
      evaluateVersionCoverage: jest.fn().mockResolvedValue({
        status: 'NOT_REQUIRED',
        checkedAt: new Date().toISOString(),
        requiredCountryCodes: [],
        coveredCountryCodes: [],
        uncoveredCountryCodes: [],
        countries: [],
        licenseIds: [],
        blockers: [],
        warnings: [],
        attributionTextsRu: [],
      }),
    };
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
    rightsRecheckService = {
      ensureTask: jest.fn().mockResolvedValue({ task: { id: 'task-1' }, created: true }),
      getRuntimeConfig: jest.fn().mockReturnValue({
        defaultIntervalDays: 365,
        leadDays: [30, 7],
        graceDays: 30,
        legalChangeDueDays: 14,
        eventDueDays: 7,
        batchSize: 500,
        blockPublishOnOverdue: true,
      }),
      getVersionRecheck: jest.fn().mockResolvedValue({
        versionId: 'v1',
        blockers: [],
        warnings: [],
        openTasksCount: 0,
        overdueTasksCount: 0,
        blockingTasksCount: 0,
        nextRecheckDueAt: null,
        taskIds: [],
        tasks: [],
        schedule: null,
      }),
    };
    service = new BookVersionService(
      prisma as unknown as PrismaService,
      gateService as unknown as PublicationGateService,
      mockRightsContentHashService,
      {
        assertAccess: jest.fn(),
      } as unknown as GeoBlockRuleService,
      licenseCoverageService as unknown as RightsLicenseCoverageService,
      rightsClaimsService as unknown as RightsClaimsService,
      rightsRecheckService as unknown as RightsRecheckService,
      new TerritoryRegionAggregationService(),
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

  // Phase 18: adding a language version to a cleared book opens a recheck task.
  describe('Phase 18 LANGUAGE_ADDED hook', () => {
    const arrangeCreate = (rightsProfileId: string | null) => {
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
        id: 'v-new',
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
        seoId: null,
        rightsProfileId,
        approvedRightsReviewId: 'review-1',
      });
      return {
        language: Language.es,
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'u',
        type: BookType.text,
        isFree: true,
      } as CreateBookVersionDto;
    };

    it('opens a LANGUAGE_ADDED recheck task for a version with a rights profile', async () => {
      const dto = arrangeCreate('profile-1');

      await service.create('b1', dto);

      expect(rightsRecheckService.ensureTask).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'LANGUAGE_ADDED',
          source: 'VERSION_CREATED',
          rightsProfileId: 'profile-1',
          bookVersionId: 'v-new',
        }),
      );
    });

    it('does not fail version creation when opening the recheck task throws', async () => {
      const dto = arrangeCreate('profile-1');
      rightsRecheckService.ensureTask.mockRejectedValue(new Error('recheck unavailable'));

      const res = await service.create('b1', dto);

      expect(res.id).toBe('v-new');
    });

    it('skips the hook for a version without a rights profile', async () => {
      const dto = arrangeCreate(null);

      await service.create('b1', dto);

      expect(rightsRecheckService.ensureTask).not.toHaveBeenCalled();
    });
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
      // Phase 16: a version with no claims reports zeroed claim metrics, never undefined.
      expect(res.claims).toEqual([]);
      expect(res.summary.claimsCount).toBe(0);
      expect(res.summary.activeClaimsCount).toBe(0);
      expect(res.summary.hasWorldwideClaimBlock).toBe(false);
      expect(res.currentVersion.rightsClaimBlockActive).toBe(false);
    });

    it('aggregates claim metrics from the claims service (Phase 16)', async () => {
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
        rightsClaimBlockActive: true,
        rightsClaimBlockAppliedAt: new Date('2026-07-28T10:00:00.000Z'),
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
        blockingReasons: [],
        warnings: [],
      });
      (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mockResolvedValue({
        matchesBaseline: false,
        recheckRequired: false,
      });
      rightsClaimsService.listForVersion.mockResolvedValue({
        items: [
          {
            id: 'claim-1',
            claimNumber: 'CLM-2026-000001',
            severity: 'CRITICAL',
            isOpen: true,
            isOverdue: true,
            blocksPublication: true,
            activeBlocksCount: 2,
            hasWorldwideBlock: true,
            blockedCountryCodes: ['DE', 'FR'],
          },
          {
            id: 'claim-2',
            claimNumber: 'CLM-2026-000002',
            severity: 'LOW',
            isOpen: false,
            isOverdue: false,
            blocksPublication: true,
            activeBlocksCount: 0,
            hasWorldwideBlock: false,
            blockedCountryCodes: [],
          },
        ],
        total: 2,
        page: 1,
        limit: 2,
      });

      const res = await service.getRightsDashboard('v1');

      expect(res.claims).toHaveLength(2);
      expect(res.summary.claimsCount).toBe(2);
      expect(res.summary.activeClaimsCount).toBe(1);
      expect(res.summary.blockingClaimsCount).toBe(1);
      expect(res.summary.criticalClaimsCount).toBe(1);
      expect(res.summary.overdueClaimsCount).toBe(1);
      expect(res.summary.activeClaimBlocksCount).toBe(2);
      expect(res.summary.claimBlockedCountriesCount).toBe(2);
      expect(res.summary.hasWorldwideClaimBlock).toBe(true);
      expect(res.summary.worstClaimSeverity).toBe('CRITICAL');
      expect(res.currentVersion.rightsClaimBlockActive).toBe(true);
      expect(res.currentVersion.rightsClaimBlockAppliedAt).toBe('2026-07-28T10:00:00.000Z');
    });

    it('should return full rights dashboard payload when clearance profile and history exist', async () => {
      const mockVersionWithClearance = {
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        type: 'text',
        status: 'published',
        title: 'Title EN',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        rightsStatus: 'APPROVED',
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
        rightsGeoBlockConfiguredAt: new Date('2026-07-26T10:00:00Z'),
        rightsGeoBlockNotesRu: 'Geo-block configured',
        rightsContentHash: 'hash-v1',
        rightsContentHashAlgorithmVersion: 'v1',
        rightsContentHashCalculatedAt: new Date('2026-07-26T10:00:00Z'),
        rightsRecheckRequired: false,
        rightsStaleDetectedAt: null,
        rightsStaleReasonCode: null,
        rightsStaleReasonRu: null,
        book: {
          id: 'b1',
          slug: 'slug-b1',
          rightsIntakeId: 'intake-1',
          currentRightsProfileId: 'profile-1',
          approvedRightsReviewId: 'review-1',
          rightsCreatedAt: new Date('2026-07-26T10:00:00Z'),
        },
      };

      const mockSiblingVersion = {
        id: 'v2',
        language: 'es',
        type: 'text',
        status: 'draft',
        title: 'Title ES',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        rightsStatus: 'APPROVED',
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: false,
        rightsRecheckRequired: true,
        rightsStaleDetectedAt: new Date('2026-07-26T11:00:00Z'),
      };

      const mockIntake = {
        id: 'intake-1',
        candidateTitle: 'Pride and Prejudice',
        candidateAuthor: 'Jane Austen',
        workflowStatus: 'BOOK_CREATED',
      };
      const expiringComponentRightsAt = new Date();
      expiringComponentRightsAt.setDate(expiringComponentRightsAt.getDate() + 30);

      const mockProfile = {
        id: 'profile-1',
        rightsIntakeId: 'intake-1',
        overallStatus: 'APPROVED',
        confidence: 'HIGH',
        publicationGate: 'ALLOW',
        sourceEdition: {
          id: 'source-1',
          provider: 'PROJECT_GUTENBERG',
          externalId: '1342',
          sourceTitle: 'Pride and Prejudice',
          sourceLanguage: 'en',
          sourceTextType: 'ORIGINAL_TEXT',
          gutenbergStatus: 'PUBLIC_DOMAIN_US',
          status: 'VERIFIED',
          editionRights: {
            id: 'ed-rights-1',
            status: 'PUBLIC_DOMAIN',
            notesRu: 'Note',
            legalBasisRu: 'US 70 pMA',
          },
        },
        territoryDecisions: [
          {
            countryCode: 'US',
            accessPolicy: 'ALLOW',
            finalStatus: 'PUBLIC_DOMAIN',
            geoBlockRequired: false,
          },
          {
            countryCode: 'GB',
            accessPolicy: 'BLOCK',
            finalStatus: 'BLOCKED',
            geoBlockRequired: true,
          },
          {
            countryCode: 'FR',
            accessPolicy: 'LICENSE_REQUIRED',
            finalStatus: 'LICENSE_REQUIRED',
            geoBlockRequired: false,
          },
          {
            countryCode: 'CA',
            accessPolicy: 'REVIEW_REQUIRED',
            finalStatus: 'PENDING_REVIEW',
            geoBlockRequired: false,
          },
          {
            countryCode: 'AU',
            accessPolicy: 'REVIEW_REQUIRED',
            finalStatus: 'NOT_CHECKED',
            geoBlockRequired: false,
          },
          {
            countryCode: 'MX',
            accessPolicy: 'REVIEW_REQUIRED',
            finalStatus: 'UNCERTAIN',
            geoBlockRequired: false,
          },
          {
            countryCode: 'BR',
            accessPolicy: 'REVIEW_REQUIRED',
            finalStatus: 'PENDING',
            geoBlockRequired: false,
          },
        ],
        components: [
          {
            id: 'comp-1',
            componentType: 'ORIGINAL_TEXT',
            status: 'PUBLIC_DOMAIN',
            territoryAssessments: [
              {
                id: 'assessment-1',
                countryCode: 'GB',
                accessPolicy: 'BLOCK',
                geoBlockRequired: true,
                rightsExpireAt: expiringComponentRightsAt,
              },
              {
                id: 'assessment-2',
                countryCode: 'CA',
                accessPolicy: 'REVIEW_REQUIRED',
                geoBlockRequired: false,
                rightsExpireAt: null,
              },
              {
                id: 'assessment-3',
                countryCode: 'US',
                accessPolicy: 'ALLOW',
                geoBlockRequired: false,
                rightsExpireAt: null,
              },
            ],
          },
        ],
        evidence: [{ id: 'ev-1', evidenceType: 'AUTHOR_DEATH_YEAR_RECORD' }],
        actions: [
          { id: 'act-1', actionType: 'CONFIGURE_GEO_BLOCK', status: 'PENDING', isBlocking: true },
        ],
      };

      const mockReview = {
        id: 'review-1',
        rightsProfileId: 'profile-1',
        overallStatus: 'APPROVED',
        publicationGate: 'ALLOW',
        confidence: 'HIGH',
        rightsReviewImport: { id: 'import-1', provider: 'COMMUNITY' },
      };

      const mockApproval = {
        id: 'approval-1',
        rightsIntakeId: 'intake-1',
        decision: 'APPROVE',
        createdAt: new Date('2026-07-26T10:00:00Z'),
      };

      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(mockVersionWithClearance);
      (prisma.bookVersion.findMany as jest.Mock).mockResolvedValue([
        mockVersionWithClearance,
        mockSiblingVersion,
      ]);
      (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue(mockIntake);
      prisma.rightsReviewApproval.findMany.mockResolvedValue([mockApproval]);
      prisma.rightsProfile.findUnique.mockResolvedValue(mockProfile);
      prisma.rightsReview.findMany.mockResolvedValue([mockReview]);

      (gateService.checkVersionCanPublish as jest.Mock).mockResolvedValue({
        canPublish: true,
        blockingReasons: [],
        warnings: [],
      });
      (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mockResolvedValue({
        matchesBaseline: true,
        isStale: false,
        recheckRequired: false,
      });

      const res = await service.getRightsDashboard('v1');
      expect(res.summary.hasClearance).toBe(true);
      expect(res.summary.canPublishCurrentVersion).toBe(true);
      expect(res.summary.publicationGate).toBe('ALLOW');
      expect(res.summary.blockedCountriesCount).toBe(1);
      expect(res.summary.licenseRequiredCountriesCount).toBe(1);
      expect(res.summary.pendingCountriesCount).toBe(4);
      expect(res.summary.geoBlockRequiredCount).toBe(1);
      expect(res.summary.unresolvedBlockingActionsCount).toBe(1);
      expect(res.summary.evidenceCount).toBe(1);
      expect(res.summary.componentsCount).toBe(1);
      expect(res.summary.componentTerritoryAssessmentsCount).toBe(3);
      expect(res.summary.blockedComponentTerritoryAssessmentsCount).toBe(1);
      expect(res.summary.reviewRequiredComponentTerritoryAssessmentsCount).toBe(1);
      expect(res.summary.expiringComponentTerritoryAssessmentsCount).toBe(1);
      expect(res.summary.regionCount).toBe(7);
      expect(res.summary.blockedRegionCount).toBe(1);
      expect(res.summary.licenseRequiredRegionCount).toBe(1);
      expect(res.versions).toHaveLength(2);
      expect(res.currentProfile).toBeDefined();
      expect(
        (res.currentProfile?.['sourceEdition'] as Record<string, unknown>)['editionRights'],
      ).toBeDefined();
      expect(res.currentProfile?.['regionalTerritorySummary'] as unknown[]).toHaveLength(7);
      expect(
        (res.currentProfile?.['components'] as Array<Record<string, unknown>>)[0][
          'territoryAssessments'
        ] as unknown[],
      ).toHaveLength(3);
      expect(prisma.rightsProfile.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            components: {
              include: {
                territoryAssessments: {
                  orderBy: [{ countryCode: 'asc' }],
                },
              },
            },
          }),
        }),
      );
      expect(res.reviewHistory).toHaveLength(1);
      expect(res.approvalHistory).toHaveLength(1);
    });
    // Phase 15: license metrics in the dashboard summary
    it('returns license metrics and coverage in the dashboard summary', async () => {
      const licenseRow = {
        id: 'lic-1',
        title: 'Лицензия на перевод',
        licensor: 'Penguin',
        licenseType: 'DIRECT_LICENSE',
        status: 'ACTIVE',
        territoryScope: 'COUNTRY_LIST',
        expiresAt: null,
        isPerpetual: true,
        attributionRequired: true,
      };

      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        type: 'text',
        status: 'draft',
        title: 'Title EN',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: null,
        rightsStatus: 'APPROVED_WITH_LICENSES',
        rightsGeoBlockRequired: false,
        rightsGeoBlockConfigured: false,
        rightsRecheckRequired: false,
        rightsLicenseCoverageStatus: 'COVERED',
        rightsLicenseCheckedAt: new Date('2026-07-28T00:00:00Z'),
        rightsLicenseIds: ['lic-1'],
        book: {
          id: 'b1',
          slug: 'book',
          rightsIntakeId: null,
          currentRightsProfileId: 'profile-1',
          approvedRightsReviewId: null,
          rightsCreatedAt: null,
        },
      });
      (prisma.bookVersion.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue(null);
      prisma.rightsReviewApproval.findMany.mockResolvedValue([]);
      prisma.rightsProfile.findUnique.mockResolvedValue({
        id: 'profile-1',
        overallStatus: 'PUBLISHABLE',
        confidence: 'HIGH',
        components: [],
        territoryDecisions: [],
        evidence: [],
        actions: [],
        contributors: [],
      });
      prisma.rightsReview.findMany.mockResolvedValue([]);

      (gateService.checkVersionCanPublish as jest.Mock).mockResolvedValue({
        canPublish: true,
        blockingReasons: [],
        warnings: [],
      });
      (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mockResolvedValue({
        matchesBaseline: true,
        isStale: false,
        recheckRequired: false,
      });

      licenseCoverageService.loadLicensesForProfile.mockResolvedValue([licenseRow]);
      licenseCoverageService.evaluateVersionCoverage.mockResolvedValue({
        status: 'COVERED',
        checkedAt: '2026-07-28T00:00:00.000Z',
        requiredCountryCodes: ['ES'],
        coveredCountryCodes: ['ES'],
        uncoveredCountryCodes: [],
        countries: [],
        licenseIds: ['lic-1'],
        blockers: [],
        warnings: [],
        attributionTextsRu: ['© Penguin Random House, 2019'],
      });

      const res = await service.getRightsDashboard('v1');

      expect(res.summary.licensesCount).toBe(1);
      expect(res.summary.activeLicensesCount).toBe(1);
      expect(res.summary.expiredLicensesCount).toBe(0);
      expect(res.summary.revokedLicensesCount).toBe(0);
      expect(res.summary.attributionRequiredLicensesCount).toBe(1);
      expect(res.summary.licenseCoverageStatus).toBe('COVERED');
      expect(res.summary.licenseCoveredCountriesCount).toBe(1);
      expect(res.summary.licenseUncoveredCountriesCount).toBe(0);
      expect(res.currentProfile?.['licenses'] as unknown[]).toHaveLength(1);
      expect(res.currentVersion.rightsLicenseCoverageStatus).toBe('COVERED');
      expect(res.currentVersion.rightsLicenseIds).toEqual(['lic-1']);
    });
  });
});
