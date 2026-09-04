import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { TerritoryRegionAggregationService } from '../rights-intake/territory-region-aggregation.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoIpCountryService } from '../geo-block/geo-ip-country.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { RightsRecheckService } from '../rights-recheck/rights-recheck.service';
import { RightsLawyerReviewService } from '../rights-lawyer/rights-lawyer-review.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
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
  bookVersionContributor: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  person: {
    findUnique: jest.Mock;
  };
  // Версия связывается с автором ключом, а не только строкой: сервис выводит
  // `authorId` из имени автора внутри той же транзакции.
  authorTranslation: {
    findFirst: jest.Mock;
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
    bookVersionContributor: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    person: {
      findUnique: jest.fn(),
    },
    authorTranslation: {
      // По умолчанию совпадения нет — тогда ключ остаётся пустым, и поведение
      // прежних тестов не меняется.
      findFirst: jest.fn().mockResolvedValue(null),
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
  let finalizeBaselineOnPublish: jest.Mock;
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
  let geoIpCountryService: { getSourceHealth: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    geoIpCountryService = {
      getSourceHealth: jest.fn().mockReturnValue({
        status: 'HEALTHY',
        resolvedCount: 10,
        unknownCount: 0,
        totalCount: 10,
        unknownRatio: 0,
        lastResolvedHeader: 'cf-ipcountry',
        lastResolvedAt: '2026-07-31T12:00:00.000Z',
        lastUnknownAt: null,
        windowStartedAt: '2026-07-31T09:00:00.000Z',
      }),
    };
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
    finalizeBaselineOnPublish = jest.fn();
    mockRightsContentHashService = {
      computeVersionHash: jest.fn(),
      initializeVersionBaseline: jest.fn(),
      checkVersionStaleness: jest.fn(),
      markVersionAndClearanceStale: jest.fn(),
      finalizeBaselineOnPublish,
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
    const rightsLawyerReviewService = {
      getVersionLawyerReview: jest.fn().mockResolvedValue({
        versionId: 'v1',
        bookId: 'b1',
        rightsProfileId: null,
        blockers: [],
        warnings: [],
        lawyerReviewRequired: false,
        lawyerApproved: false,
        openReviewsCount: 0,
        pendingConditionsCount: 0,
        riskLevel: null,
        lawyerOpinionValidUntil: null,
        reviewIds: [],
        lawyerApprovedAt: null,
        lawyerApprovedLawyerName: null,
        isExpiringSoon: false,
        reviews: [],
        pendingConditions: [],
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
      rightsLawyerReviewService as unknown as RightsLawyerReviewService,
      geoIpCountryService as unknown as GeoIpCountryService,
      {
        record: jest.fn().mockResolvedValue(undefined),
        recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
        resolve: jest.fn().mockResolvedValue(null),
      } as unknown as SlugRedirectService,
      new TerritoryRegionAggregationService(),
    );
  });

  /** Минимальный набор моков, при котором `create` доходит до записи версии. */
  const arrangeSimpleCreate = () => {
    (prisma.book.findUnique as jest.Mock).mockResolvedValue({
      id: 'b1',
      rightsIntakeId: 'intake-1',
      currentRightsProfileId: null,
      approvedRightsReviewId: null,
    });
    (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
      id: 'intake-1',
      targetLanguages: ['en', 'es'],
    });
    (prisma.bookVersion.findFirst as jest.Mock).mockResolvedValue(null);
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
      createdAt: new Date(),
      updatedAt: new Date(),
      seoId: null,
      seo: null,
    });
  };

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

  /**
   * 🔴 `BookVersion.authorId` существовал в схеме, принимался в DTO и читался
   * кодом — но его не проставлял никто: на проде он был NULL у **всех 45**
   * версий. Из-за этого список авторов показывал «0 книг» всем десяти, включая
   * тех, чьи книги лежат в каталоге.
   *
   * Ключ выводится в сервисе, а не в форме админки, намеренно: форма — лишь один
   * из писателей, есть ещё импорт и приёмка прав.
   */
  it('links a new version to the author by key, resolved from the name', async () => {
    arrangeSimpleCreate();
    prisma.authorTranslation.findFirst.mockResolvedValue({ authorId: 'author-1' });

    await service.create('b1', {
      language: Language.en,
      title: 'T',
      author: 'Sun Tzu',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
    });

    const data = (prisma.bookVersion.create as jest.Mock).mock.calls[0][0].data as {
      authorId?: string | null;
    };
    expect(data.authorId).toBe('author-1');
  });

  // Автора может не быть в справочнике вовсе — это не сбой. Пустой ключ честнее
  // выдуманного, а поштучный резолвинг книг по имени всё равно работает.
  it('leaves the key empty when the name matches no author', async () => {
    arrangeSimpleCreate();
    prisma.authorTranslation.findFirst.mockResolvedValue(null);

    await service.create('b1', {
      language: Language.en,
      title: 'T',
      author: 'Nobody In The Catalogue',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
    });

    const data = (prisma.bookVersion.create as jest.Mock).mock.calls[0][0].data as {
      authorId?: string | null;
    };
    expect(data.authorId).toBeNull();
  });

  // У человека может быть причина связать версию с автором, чьё имя записано
  // иначе, — явный ключ вывод не переспоривает.
  it('keeps an explicitly supplied authorId', async () => {
    arrangeSimpleCreate();
    prisma.authorTranslation.findFirst.mockResolvedValue({ authorId: 'guessed' });

    await service.create('b1', {
      language: Language.en,
      title: 'T',
      author: 'Sun Tzu',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
      authorId: 'chosen-by-hand',
    });

    const data = (prisma.bookVersion.create as jest.Mock).mock.calls[0][0].data as {
      authorId?: string | null;
    };
    expect(data.authorId).toBe('chosen-by-hand');
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

  /**
   * WP-10.6 (R2-02) + WP-10.9 (R2-03). Phase 6 made rights the only entrance for content: a book
   * without an approved intake gets no versions, and a version gets no language the intake did not
   * clear. Both guards existed and neither was covered — the sanctioned path had 27 tests, the
   * forbidden ones none. The language guard was also written fail-open (`intake?.targetLanguages &&
   * !includes(...)`): a missing intake row or a JSON `null` list turned it off silently.
   */
  describe('creation integrity: the forbidden paths stay closed', () => {
    const dto: CreateBookVersionDto = {
      language: Language.fr,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
    };

    const arrangeBook = (rightsIntakeId: string | null) => {
      (prisma.book.findUnique as jest.Mock).mockResolvedValue({
        id: 'b1',
        rightsIntakeId,
        currentRightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
      });
      (prisma.bookVersion.findFirst as jest.Mock).mockResolvedValue(null);
    };

    it('refuses a version for a book without an approved rights clearance', async () => {
      arrangeBook(null);

      await expect(service.create('b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookVersion.create).not.toHaveBeenCalled();
    });

    it('refuses a language the intake did not clear', async () => {
      arrangeBook('intake-1');
      (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
        id: 'intake-1',
        targetLanguages: ['en', 'es'],
      });

      await expect(service.create('b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookVersion.create).not.toHaveBeenCalled();
    });

    it('refuses creation when the referenced intake row is gone (R2-03)', async () => {
      arrangeBook('intake-1');
      (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.create('b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookVersion.create).not.toHaveBeenCalled();
    });

    it('refuses creation when the intake carries a JSON null instead of a language list (R2-03)', async () => {
      arrangeBook('intake-1');
      (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
        id: 'intake-1',
        targetLanguages: null,
      });

      await expect(service.create('b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookVersion.create).not.toHaveBeenCalled();
    });

    it('refuses creation when the intake cleared no language at all (R2-03)', async () => {
      arrangeBook('intake-1');
      (prisma.rightsIntake.findUnique as jest.Mock).mockResolvedValue({
        id: 'intake-1',
        targetLanguages: [],
      });

      await expect(service.create('b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookVersion.create).not.toHaveBeenCalled();
    });
  });

  /**
   * WP-10.9 (R1-03). Geo-block rules belong to a version, so a freshly created version has none.
   * Copying `rightsGeoBlockConfigured` from a sibling made the version claim a configuration it
   * does not have, and gate block 6.13 answered with a warning instead of a blocker.
   */
  it('does not inherit the geo-block confirmation from the sibling version', async () => {
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
    (prisma.bookVersion.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // duplicate-language check
      .mockResolvedValueOnce({
        id: 'sibling-v',
        primaryCategoryId: null,
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        rightsStatus: 'APPROVED',
        rightsAllowedCountryCodes: [],
        rightsBlockedCountryCodes: ['GB'],
        rightsLicenseRequiredCountryCodes: [],
        rightsPendingCountryCodes: [],
        rightsRequiredActions: [],
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
        rightsGeoBlockConfiguredAt: new Date('2026-07-26T10:00:00Z'),
        rightsGeoBlockNotesRu: 'Правила проверены редактором',
      });
    (prisma.bookCategory.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.bookTag.findMany as jest.Mock).mockResolvedValue([]);
    const now = new Date();
    (prisma.bookVersion.create as jest.Mock).mockResolvedValue({
      id: 'new-v',
      bookId: 'b1',
      language: Language.es,
      createdAt: now,
      updatedAt: now,
    });

    await service.create('b1', {
      language: Language.es,
      title: 'T',
      author: 'A',
      description: 'D',
      coverImageUrl: 'u',
      type: BookType.text,
      isFree: true,
    } as CreateBookVersionDto);

    const createArgs = (prisma.bookVersion.create as jest.Mock).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // The obligation is inherited, the confirmation is not.
    expect(createArgs.data.rightsGeoBlockRequired).toBe(true);
    expect(createArgs.data.rightsGeoBlockConfigured).toBe(false);
    expect(createArgs.data.rightsGeoBlockConfiguredAt).toBeNull();
    expect(createArgs.data.rightsGeoBlockNotesRu).toBeNull();
    expect(createArgs.data.rightsGeoBlockVerifiedAt).toBeNull();
    expect(createArgs.data.rightsGeoBlockVerifiedByUserId).toBeNull();
  });

  it('updates version and updates existing seo', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      seoId: 10,
      status: 'draft',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      language: Language.en,
      author: 'A',
      slug: 'karamazovy',
    } as unknown as BookVersion);
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

  /**
   * Черновик наполняется по частям, и версия заводится с тем, что уже введено: колонки в схеме
   * обязательные, поэтому незаполненное описание и обложка ложатся пустой строкой. Наружу такая
   * оболочка не уходит — версия создаётся черновиком, а публикацию закрывает блокер гейта
   * `VERSION_CONTENT_INCOMPLETE`.
   */
  it('creates a version without description and cover image', async () => {
    arrangeSimpleCreate();

    await service.create('b1', {
      language: Language.en,
      title: 'T',
      author: 'A',
      type: BookType.text,
      isFree: true,
    });

    const createArgs = (prisma.bookVersion.create as jest.Mock).mock
      .calls[0][0] as Prisma.BookVersionCreateArgs;
    expect(createArgs.data.description).toBe('');
    expect(createArgs.data.coverImageUrl).toBe('');
    // В схеме у `status` стоит `@default(published)`: без явного черновика пустая оболочка
    // попала бы в публичную выдачу сразу, минуя гейт.
    expect(createArgs.data.status).toBe('draft');
  });

  /** Послабление касается только черновика: у живой карточки заполненное поле не стирается. */
  it('refuses to empty the description of a published version', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);

    await expect(service.update('v1', { description: '   ' })).rejects.toThrow(/description/);
    await expect(service.update('v1', { description: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.bookVersion.update).not.toHaveBeenCalled();
  });

  it('refuses to empty the cover image of a published version', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);

    await expect(service.update('v1', { coverImageUrl: '' })).rejects.toThrow(/coverImageUrl/);
    expect(prisma.bookVersion.update).not.toHaveBeenCalled();
  });

  /**
   * Запрет — про опустошение, а не про наполненность вообще. Опубликованные версии с пустым
   * описанием в базе возможны (блокер гейта появился позже них, ADR-008), и требование
   * наполненности от всякой правки заперло бы у такой карточки слаг и SEO.
   */
  it('lets an unrelated field be edited on a published version whose description is already empty', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: '',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);
    const now = new Date();
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      bookId: 'b1',
      language: Language.en,
      title: 'T',
      author: 'A',
      description: '',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      type: BookType.text,
      isFree: false,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: null,
      seo: null,
    });

    await service.update('v1', { isFree: false });

    expect(prisma.bookVersion.update).toHaveBeenCalled();
  });

  it('names both fields when the edit clears the description and the cover at once', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);

    await expect(service.update('v1', { description: '', coverImageUrl: '' })).rejects.toThrow(
      /description and coverImageUrl/,
    );
  });

  /**
   * Описание приходит из визуального редактора: пустой абзац — это пустое описание, хотя строка
   * непустая. Иначе запрет обходится подстановкой `<p></p>`, и читатель видит карточку без текста.
   */
  it('treats an empty paragraph as an empty description', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: '<p>Роман</p>',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);

    await expect(service.update('v1', { description: '<p>&nbsp;</p>' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.bookVersion.update).not.toHaveBeenCalled();
  });

  it('lets a published version keep a description, replacing it with another one', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: '<p>Роман</p>',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({ id: 'v1' } as BookVersion);

    await service.update('v1', { description: '<p>Другой текст</p>' });

    const updateArgs = (prisma.bookVersion.update as jest.Mock).mock
      .calls[0][0] as Prisma.BookVersionUpdateArgs;
    expect(updateArgs.data.description).toBe('<p>Другой текст</p>');
    // Правка ничего не стирает, поэтому условие на статус в запись не добавляется.
    expect(updateArgs.where).toEqual({ id: 'v1' });
  });

  it('sends an empty field to a published version whose field is already empty', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      description: '',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({ id: 'v1' } as BookVersion);

    await service.update('v1', { description: '', title: 'Новое название' });

    expect(prisma.bookVersion.update).toHaveBeenCalled();
    const updateArgs = (prisma.bookVersion.update as jest.Mock).mock
      .calls[0][0] as Prisma.BookVersionUpdateArgs;
    expect(updateArgs.where).toEqual({ id: 'v1' });
  });

  /**
   * Прочитанный статус к моменту записи может устареть: параллельный `publish` строку не держит.
   * Поэтому стирающая правка пишется с условием на статус, а не только после проверки в памяти.
   */
  it('writes a clearing edit only while the version is still a draft', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'draft',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({ id: 'v1' } as BookVersion);

    await service.update('v1', { description: '' });

    const updateArgs = (prisma.bookVersion.update as jest.Mock).mock
      .calls[0][0] as Prisma.BookVersionUpdateArgs;
    expect(updateArgs.where).toEqual({ id: 'v1', status: 'draft' });
  });

  it('answers 400, not 500, when the version was published mid-edit', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'draft',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);
    (prisma.bookVersion.update as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Record to update not found'), { code: 'P2025' }),
    );

    await expect(service.update('v1', { description: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('lets a draft be saved with an empty description', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'draft',
      description: 'D',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      seoId: null,
    } as unknown as BookVersion);
    const now = new Date();
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      bookId: 'b1',
      language: Language.en,
      title: 'T',
      author: 'A',
      description: '',
      coverImageUrl: '',
      type: BookType.text,
      isFree: true,
      referralUrl: null,
      createdAt: now,
      updatedAt: now,
      seoId: null,
      seo: null,
    });

    await service.update('v1', { description: '', coverImageUrl: '' });

    const updateArgs = (prisma.bookVersion.update as jest.Mock).mock
      .calls[0][0] as Prisma.BookVersionUpdateArgs;
    expect(updateArgs.data.description).toBe('');
    expect(updateArgs.data.coverImageUrl).toBe('');
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
    // WP-H: публикация обязана звать гейт полной стадией — послабления стадии подготовки
    // до этого пути не доходят.
    expect(gateService.assertVersionCanPublish).toHaveBeenCalledWith('v1', 'PUBLICATION');

    const unpub = await service.unpublish('v1');
    expect(unpub.status).toBe('draft');
    // unpublish should NOT call publication gate
    expect(gateService.assertVersionCanPublish).toHaveBeenCalledTimes(1);
  });

  /**
   * WP-D.4: публикация — жёсткий выход из окна наполнения черновика. Слепок фиксируется
   * в той же транзакции, что и смена статуса, иначе окно осталось бы открытым.
   */
  it('publish fixes the content hash baseline in the same transaction', async () => {
    const now = new Date();
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({ id: 'v1' });
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      publishedAt: now,
    });

    await service.publish('v1');

    expect(finalizeBaselineOnPublish).toHaveBeenCalledWith('v1', null, prisma);
  });

  it('publish does not fix the baseline when the gate blocks', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({ id: 'v1' });
    gateService.assertVersionCanPublish.mockRejectedValue(new BadRequestException('blocked'));

    await expect(service.publish('v1')).rejects.toBeInstanceOf(BadRequestException);
    expect(finalizeBaselineOnPublish).not.toHaveBeenCalled();
  });

  it('unpublish does not reopen the draft fill window', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({ id: 'v1' });
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'draft',
      publishedAt: null,
    });

    await service.unpublish('v1');

    expect(finalizeBaselineOnPublish).not.toHaveBeenCalled();
  });

  /**
   * Гейт читает версию до транзакции, и между вердиктом и записью её успевает опустошить чужая
   * правка. Поэтому условие на непустое содержимое стоит и в самой записи — его проверяет база.
   */
  it('publishes only while the description and the cover are not empty', async () => {
    const now = new Date();
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'draft',
    } as BookVersion);
    (prisma.bookVersion.update as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'published',
      publishedAt: now,
    } as BookVersion);

    await service.publish('v1');

    const updateArgs = (prisma.bookVersion.update as jest.Mock).mock
      .calls[0][0] as Prisma.BookVersionUpdateArgs;
    expect(updateArgs.where).toEqual({
      id: 'v1',
      description: { not: '' },
      coverImageUrl: { not: '' },
    });
  });

  it('answers 400, not 500, when the version was emptied between the gate and the write', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      id: 'v1',
      status: 'draft',
    } as BookVersion);
    (prisma.bookVersion.update as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Record to update not found'), { code: 'P2025' }),
    );

    await expect(service.publish('v1')).rejects.toBeInstanceOf(BadRequestException);
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

    it('warns in the dashboard when geo-block is mandatory but the country source is gone (WP-1.2а)', async () => {
      const mockVersion = {
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        type: 'text',
        status: 'published',
        title: 'Title',
        rightsProfileId: null,
        approvedRightsReviewId: null,
        rightsStatus: null,
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
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
        canPublish: true,
        blockingReasons: [],
        warnings: [],
      });
      (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mockResolvedValue({
        matchesBaseline: true,
        recheckRequired: false,
      });
      geoIpCountryService.getSourceHealth.mockReturnValue({
        status: 'UNAVAILABLE',
        resolvedCount: 0,
        unknownCount: 40,
        totalCount: 40,
        unknownRatio: 1,
        lastResolvedHeader: null,
        lastResolvedAt: null,
        lastUnknownAt: '2026-07-31T12:00:00.000Z',
        windowStartedAt: '2026-07-31T09:00:00.000Z',
      });

      const res = await service.getRightsDashboard('v1');

      expect(res.geoCountrySource?.status).toBe('UNAVAILABLE');
      expect(res.summary.geoCountrySourceWarning).toBe(true);
    });

    it('stays silent about the country source when geo-block is not required (WP-1.2а)', async () => {
      const mockVersion = {
        id: 'v1',
        bookId: 'b1',
        language: 'en',
        type: 'text',
        status: 'published',
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
        canPublish: true,
        blockingReasons: [],
        warnings: [],
      });
      (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mockResolvedValue({
        matchesBaseline: true,
        recheckRequired: false,
      });
      geoIpCountryService.getSourceHealth.mockReturnValue({
        status: 'UNAVAILABLE',
        resolvedCount: 0,
        unknownCount: 40,
        totalCount: 40,
        unknownRatio: 1,
        lastResolvedHeader: null,
        lastResolvedAt: null,
        lastUnknownAt: '2026-07-31T12:00:00.000Z',
        windowStartedAt: '2026-07-31T09:00:00.000Z',
      });

      const res = await service.getRightsDashboard('v1');

      expect(res.summary.geoCountrySourceWarning).toBe(false);
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
        overallStatus: 'PUBLISHABLE',
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
            finalStatus: 'ALLOWED',
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
            accessPolicy: 'REVIEW_REQUIRED',
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
        evidence: [{ id: 'ev-1', evidenceType: 'AUTHORITY_RECORD' }],
        actions: [
          { id: 'act-1', actionType: 'CONFIGURE_GEO_BLOCK', status: 'PENDING', isBlocking: true },
        ],
      };

      const mockReview = {
        id: 'review-1',
        rightsProfileId: 'profile-1',
        overallStatus: 'PUBLISHABLE',
        publicationGate: 'ALLOW',
        confidence: 'HIGH',
        rightsReviewImport: { id: 'import-1' },
      };

      const mockApproval = {
        id: 'approval-1',
        rightsIntakeId: 'intake-1',
        decision: 'APPROVED',
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

  /**
   * WP-8.1 (R1-01). Смена переводчика — правовое событие: год его смерти определяет,
   * в public domain ли перевод. До WP-8 состав участников менялся, не задевая клиренс.
   */
  describe('version contributors trigger the content hash check', () => {
    beforeEach(() => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
        id: 'v1',
      } as unknown as BookVersionWithSeo);
      prisma.person.findUnique.mockResolvedValue({ id: 'person-1' });
      prisma.bookVersionContributor.create.mockResolvedValue({ id: 'bvc-1' });
      prisma.bookVersionContributor.update.mockResolvedValue({ id: 'bvc-1' });
      prisma.bookVersionContributor.delete.mockResolvedValue({ id: 'bvc-1' });
      prisma.bookVersionContributor.findFirst.mockResolvedValue({
        id: 'bvc-1',
        bookVersionId: 'v1',
        role: 'TRANSLATOR',
        isPrimary: false,
      });
    });

    const expectStalenessChecked = () => {
      const calls = (mockRightsContentHashService.checkVersionStaleness as jest.Mock).mock.calls;
      expect(calls).toContainEqual(['v1', 'VERSION_CONTRIBUTOR_CHANGED', null, true, prisma]);
    };

    it('checks the clearance when a contributor is added', async () => {
      await service.addVersionContributor('v1', {
        personId: 'person-1',
        role: 'TRANSLATOR',
      } as never);

      expect(prisma.bookVersionContributor.create).toHaveBeenCalled();
      expectStalenessChecked();
    });

    it('checks the clearance when a contributor is updated', async () => {
      await service.updateVersionContributor('v1', 'bvc-1', { creditedName: 'Новый' } as never);

      expectStalenessChecked();
    });

    it('checks the clearance when a contributor is removed', async () => {
      await service.removeVersionContributor('v1', 'bvc-1');

      expect(prisma.bookVersionContributor.delete).toHaveBeenCalled();
      expectStalenessChecked();
    });
  });

  /**
   * `LEGACY-349`: перестановка шла N независимыми `updateMany` на общем
   * клиенте — отказ на середине списка оставлял часть `displayOrder` новыми,
   * часть старыми, и повторить операцию было нельзя: исходного порядка
   * уже не было.
   */
  describe('reorderVersionContributors', () => {
    beforeEach(() => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
        id: 'v1',
      } as unknown as BookVersionWithSeo);
    });

    it('updates displayOrder for every id inside one transaction, in order', async () => {
      const transactionSpy = jest.spyOn(prisma, '$transaction');

      await service.reorderVersionContributors('v1', {
        contributorIds: ['bvc-1', 'bvc-2'],
      } as never);

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(prisma.bookVersionContributor.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'bvc-1', bookVersionId: 'v1' },
        data: { displayOrder: 0 },
      });
      expect(prisma.bookVersionContributor.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'bvc-2', bookVersionId: 'v1' },
        data: { displayOrder: 1 },
      });
    });

    /**
     * `LEGACY-349` (ревью): строки блокируются в порядке `id`, а не в порядке
     * из тела запроса — иначе два одновременных вызова с противоположным
     * порядком одних и тех же id берут блокировки крест-накрест и ловят
     * дедлок (`40P01`/`P2034`). `displayOrder` при этом обязан остаться
     * позицией в исходном списке, а не съехать на позицию после сортировки.
     */
    it('locks rows in id order regardless of the requested order, but keeps displayOrder as requested', async () => {
      await service.reorderVersionContributors('v1', {
        contributorIds: ['bvc-3', 'bvc-1', 'bvc-2'],
      } as never);

      expect(prisma.bookVersionContributor.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'bvc-1', bookVersionId: 'v1' },
        data: { displayOrder: 1 },
      });
      expect(prisma.bookVersionContributor.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'bvc-2', bookVersionId: 'v1' },
        data: { displayOrder: 2 },
      });
      expect(prisma.bookVersionContributor.updateMany).toHaveBeenNthCalledWith(3, {
        where: { id: 'bvc-3', bookVersionId: 'v1' },
        data: { displayOrder: 0 },
      });
    });

    /**
     * `LEGACY-349` (ревью): `prisma.$transaction` в стенде отдаёт колбэку тот
     * же самый объект `prisma`, поэтому предыдущие тесты не отличают запись
     * через `tx` от записи через `this.prisma` напрямую - оба указывают на
     * один и тот же мок. Здесь транзакция подменена на отдельный клиент,
     * чтобы доказать: пишет именно он, а не `this.prisma`.
     */
    it('writes through the transaction client, not this.prisma directly', async () => {
      const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const txClient = { bookVersionContributor: { updateMany: txUpdateMany } };
      jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce((fn: (tx: unknown) => unknown) => Promise.resolve(fn(txClient)));

      await service.reorderVersionContributors('v1', {
        contributorIds: ['bvc-1'],
      } as never);

      expect(txUpdateMany).toHaveBeenCalledWith({
        where: { id: 'bvc-1', bookVersionId: 'v1' },
        data: { displayOrder: 0 },
      });
      expect(prisma.bookVersionContributor.updateMany).not.toHaveBeenCalled();
    });

    it('rejects the whole reorder and never reads contributors back when a middle update fails', async () => {
      const dbError = new Error('db down');
      prisma.bookVersionContributor.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(dbError);

      await expect(
        service.reorderVersionContributors('v1', {
          contributorIds: ['bvc-1', 'bvc-2', 'bvc-3'],
        } as never),
      ).rejects.toBe(dbError);

      // Один клиент транзакции держит вызовы последовательными: третий id
      // не тронут вовсе, а не «отправлен параллельно и просто не дождались».
      expect(prisma.bookVersionContributor.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.bookVersionContributor.findMany).not.toHaveBeenCalled();
    });
  });
});
