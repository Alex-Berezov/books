import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';
import { BookRightsDashboardDto } from './dto/rights-dashboard.dto';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { TerritoryRegionAggregationService } from '../rights-intake/territory-region-aggregation.service';
import { Language, BookType, Prisma } from '@prisma/client';
import { ContributorRole } from '../persons/person-interface';
import { CreateBookVersionContributorDto } from './dto/create-version-contributor.dto';
import { UpdateBookVersionContributorDto } from './dto/update-version-contributor.dto';
import { ReorderBookVersionContributorsDto } from './dto/reorder-version-contributors.dto';
import { randomUUID } from 'crypto';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope, GeoCountrySourceStatus } from '../geo-block/dto/geo-block.dto';
import { GeoIpCountryService } from '../geo-block/geo-ip-country.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsLicenseStatus } from '../rights-licenses/rights-license-interface';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { CLAIM_SEVERITY_RANK } from '../rights-claims/rights-claim.constants';
import { RightsClaimSeverity } from '../rights-claims/rights-claim-interface';
import { RightsRecheckService } from '../rights-recheck/rights-recheck.service';
import { RightsLawyerReviewService } from '../rights-lawyer/rights-lawyer-review.service';
import type { VersionLawyerReviewDto } from '../rights-lawyer/dto/version-lawyer-review-response.dto';
import {
  RightsRecheckReason,
  RightsRecheckTriggerSource,
} from '../rights-recheck/rights-recheck-interface';
import { addDays } from '../rights-recheck/rights-recheck.util';

interface BookWithRights {
  id: string;
  rightsIntakeId: string | null;
  currentRightsProfileId: string | null;
  approvedRightsReviewId: string | null;
}

interface RightsIntakeWithLanguages {
  id: string;
  /** `RightsIntake.targetLanguages` is a JSON column: the shape has to be checked, not assumed. */
  targetLanguages: unknown;
}

interface SiblingVersionWithRights {
  id: string;
  primaryCategoryId: string | null;
  rightsProfileId: string | null;
  approvedRightsReviewId: string | null;
  rightsStatus: string | null;
  rightsAllowedCountryCodes: unknown;
  rightsBlockedCountryCodes: unknown;
  rightsLicenseRequiredCountryCodes: unknown;
  rightsPendingCountryCodes: unknown;
  rightsRequiredActions: unknown;
  rightsGeoBlockRequired: boolean | null;
  rightsGeoBlockConfigured: boolean | null;
  rightsGeoBlockConfiguredAt: Date | null;
  rightsGeoBlockNotesRu: string | null;
}

@Injectable()
export class BookVersionService {
  private readonly logger = new Logger(BookVersionService.name);

  constructor(
    private prisma: PrismaService,
    private publicationGateService: PublicationGateService,
    private rightsContentHashService: RightsContentHashService,
    private geoBlockRuleService: GeoBlockRuleService,
    private licenseCoverageService: RightsLicenseCoverageService,
    private rightsClaimsService: RightsClaimsService,
    // Phase 18: placed before the optional parameter — TypeScript forbids a required
    // parameter after an optional one, so it cannot literally be last.
    private rightsRecheckService: RightsRecheckService,
    // Phase 19: same reason — must sit before the optional parameter.
    private rightsLawyerReviewService: RightsLawyerReviewService,
    // WP-1.2а: the dashboard reports whether Phase 12 still has a country source at all.
    private geoIpCountryService: GeoIpCountryService,
    private regionAggregationService?: TerritoryRegionAggregationService,
  ) {}

  async list(
    bookId: string,
    filters: { language?: Language; type?: BookType; isFree?: boolean },
    acceptLanguageHeader?: string,
  ) {
    const where: Prisma.BookVersionWhereInput = {
      bookId,
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
      status: 'published',
    };
    // If no explicit language filter is provided, apply Accept-Language fallback to prefer one language
    if (!filters.language && acceptLanguageHeader) {
      const all = await this.prisma.bookVersion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { seo: true },
      });
      const available = Array.from(new Set(all.map((v) => v.language)));
      const { resolveRequestedLanguage } = await import('../../shared/language/language.util');
      const preferred = resolveRequestedLanguage({
        acceptLanguage: acceptLanguageHeader,
        available,
      });
      return preferred ? all.filter((v) => v.language === preferred) : all;
    }
    return this.prisma.bookVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }

  async create(bookId: string, dto: CreateBookVersionDto, overrideLanguage?: Language) {
    const effectiveLanguage = overrideLanguage ?? dto.language;

    // Get book with rights intake to check clearance
    const book = (await this.prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        rightsIntakeId: true,
        currentRightsProfileId: true,
        approvedRightsReviewId: true,
      },
    })) as unknown as BookWithRights | null;

    if (!book) {
      throw new NotFoundException(`Book with ID ${bookId} not found`);
    }

    // Check if book has rights clearance
    if (!book.rightsIntakeId) {
      throw new BadRequestException(
        'Cannot create version for a book without approved rights clearance',
      );
    }

    // Get rights intake to check target languages
    const rightsIntake = (await this.prisma.rightsIntake.findUnique({
      where: { id: book.rightsIntakeId },
      select: {
        id: true,
        targetLanguages: true,
      },
    })) as unknown as RightsIntakeWithLanguages | null;

    // WP-10.9 (R2-03): the check used to read `rightsIntake?.targetLanguages && !includes(...)`,
    // so a missing intake row or a JSON `null` in the column made the condition false and cleared
    // every language. An integrity check must fail closed: no readable list of cleared languages
    // means no version.
    if (!rightsIntake) {
      throw new BadRequestException(
        'Cannot create version: the rights intake of this book was not found',
      );
    }

    const targetLanguages = rightsIntake.targetLanguages;
    if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
      throw new BadRequestException(
        'Cannot create version: the rights intake of this book has no approved target languages',
      );
    }

    // Check if language is in approved target languages
    if (!targetLanguages.includes(effectiveLanguage)) {
      throw new BadRequestException(
        `Language ${effectiveLanguage} is not in approved target languages for this book`,
      );
    }

    const existing = await this.prisma.bookVersion.findFirst({
      where: { bookId, language: effectiveLanguage },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Version for this language already exists for this book');
    }

    let version;
    try {
      version = await this.prisma.$transaction(async (tx) => {
        let seoId: number | undefined;
        if (dto.seoMetaTitle || dto.seoMetaDescription) {
          const seo = await tx.seo.create({
            data: {
              metaTitle: dto.seoMetaTitle,
              metaDescription: dto.seoMetaDescription,
            },
          });
          seoId = seo.id;
        }

        // Search for any existing sibling version of this book to copy tags/categories from

        const siblingVersion = (await tx.bookVersion.findFirst({
          where: { bookId },
          orderBy: { createdAt: 'asc' },
        })) as unknown as SiblingVersionWithRights | null;

        const effectivePrimaryCategoryId =
          dto.primaryCategoryId || siblingVersion?.primaryCategoryId || undefined;

        // Copy rights snapshot from sibling version or book's current profile
        const rightsProfileId = siblingVersion?.rightsProfileId || book.currentRightsProfileId;
        const approvedRightsReviewId =
          siblingVersion?.approvedRightsReviewId || book.approvedRightsReviewId;
        const rightsStatus = siblingVersion?.rightsStatus;
        const rightsAllowedCountryCodes = siblingVersion?.rightsAllowedCountryCodes;
        const rightsBlockedCountryCodes = siblingVersion?.rightsBlockedCountryCodes;
        const rightsLicenseRequiredCountryCodes = siblingVersion?.rightsLicenseRequiredCountryCodes;
        const rightsPendingCountryCodes = siblingVersion?.rightsPendingCountryCodes;
        const rightsRequiredActions = siblingVersion?.rightsRequiredActions;

        // WP-10.9 (R1-03): the obligation to geo-block is a property of the clearance and is
        // inherited; the confirmation that it was configured is a property of this version's own
        // rules, and a version that has just been created has none. Copying it made the version
        // claim a configuration it does not have and softened gate block 6.13 to a warning.
        const rightsGeoBlockRequired = siblingVersion?.rightsGeoBlockRequired ?? false;
        const rightsGeoBlockConfigured = false;
        const rightsGeoBlockConfiguredAt = null;
        // The notes are written by `verifyRulesForVersion` together with the confirmation, so they
        // belong to it: keeping them would leave "rules checked" text on an unverified version.
        const rightsGeoBlockNotesRu = null;

        const newVersion = await tx.bookVersion.create({
          data: {
            bookId,
            language: effectiveLanguage,
            title: dto.title,
            author: dto.author,
            description: dto.description,
            coverImageUrl: dto.coverImageUrl,
            type: dto.type,
            isFree: dto.isFree,
            referralUrl: dto.referralUrl,
            seoId,
            status: 'draft',
            slug: dto.slug,
            primaryCategoryId: effectivePrimaryCategoryId,
            firstPublishedYear: dto.firstPublishedYear,
            editionPublishedYear: dto.editionPublishedYear,
            originalLanguage: dto.originalLanguage,
            copyrightStatus: dto.copyrightStatus,
            authorPageUrl: dto.authorPageUrl,
            authorId: dto.authorId,
            characters: (dto.characters as Prisma.JsonValue) ?? undefined,
            quotes: (dto.quotes as Prisma.JsonValue) ?? undefined,
            faq: (dto.faq as Prisma.JsonValue) ?? undefined,
            themes: (dto.themes as Prisma.JsonValue) ?? undefined,
            originalTitle: dto.originalTitle,
            alternativeTitles: (dto.alternativeTitles as Prisma.JsonValue) ?? undefined,
            shortDescription: dto.shortDescription,
            summaryShort: dto.summaryShort,
            symbols: (dto.symbols as Prisma.JsonValue) ?? undefined,
            coverAlt: dto.coverAlt,
            // Rights fields from clearance
            rightsProfileId,
            approvedRightsReviewId,
            rightsStatus,
            rightsAllowedCountryCodes: rightsAllowedCountryCodes as Prisma.InputJsonValue,
            rightsBlockedCountryCodes: rightsBlockedCountryCodes as Prisma.InputJsonValue,
            rightsLicenseRequiredCountryCodes:
              rightsLicenseRequiredCountryCodes as Prisma.InputJsonValue,
            rightsPendingCountryCodes: rightsPendingCountryCodes as Prisma.InputJsonValue,
            rightsRequiredActions: rightsRequiredActions as Prisma.InputJsonValue,
            // Phase 7: geo-block fields
            rightsGeoBlockRequired,
            rightsGeoBlockConfigured,
            rightsGeoBlockConfiguredAt,
            rightsGeoBlockNotesRu,
            rightsGeoBlockVerifiedAt: null,
            rightsGeoBlockVerifiedByUserId: null,
          } as Prisma.BookVersionUncheckedCreateInput & {
            rightsGeoBlockRequired: boolean;
            rightsGeoBlockConfigured: boolean;
            rightsGeoBlockConfiguredAt: Date | null;
            rightsGeoBlockNotesRu: string | null;
            rightsGeoBlockVerifiedAt: Date | null;
            rightsGeoBlockVerifiedByUserId: string | null;
          },
          include: { seo: true },
        });

        // Copy categories and tags if sibling version exists
        if (siblingVersion) {
          const siblingCategories = await tx.bookCategory.findMany({
            where: { bookVersionId: siblingVersion.id },
            select: { categoryId: true },
          });
          if (siblingCategories.length > 0) {
            await tx.bookCategory.createMany({
              data: siblingCategories.map((c) => ({
                id: randomUUID(),
                bookVersionId: newVersion.id,
                categoryId: c.categoryId,
              })),
            });
          }
          const siblingTags = await tx.bookTag.findMany({
            where: { bookVersionId: siblingVersion.id },
            select: { tagId: true },
          });
          if (siblingTags.length > 0) {
            await tx.bookTag.createMany({
              data: siblingTags.map((t) => ({
                id: randomUUID(),
                bookVersionId: newVersion.id,
                tagId: t.tagId,
              })),
            });
          }
        }

        await this.rightsContentHashService.initializeVersionBaseline(
          newVersion.id,
          'INITIAL_VERSION_SNAPSHOT',
          null,
          tx,
        );

        return newVersion;
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Version for this language already exists for this book');
      }
      throw e;
    }

    // Phase 18: a new language version of a book with approved clearance needs a recheck.
    // Called outside the transaction and wrapped in try/catch: failing to open a task must
    // never fail version creation. The initial versions of a book are created directly by
    // RightsBookCreationService (not through this method), so creating a book from an
    // approved clearance never triggers a false LANGUAGE_ADDED task here.
    if (version.rightsProfileId) {
      try {
        await this.rightsRecheckService.ensureTask({
          reason: RightsRecheckReason.LANGUAGE_ADDED,
          source: RightsRecheckTriggerSource.VERSION_CREATED,
          rightsProfileId: version.rightsProfileId,
          rightsIntakeId: book.rightsIntakeId,
          bookId,
          bookVersionId: version.id,
          baselineReviewId: version.approvedRightsReviewId ?? null,
          dueAt: addDays(new Date(), this.rightsRecheckService.getRuntimeConfig().eventDueDays),
          titleRu: `Добавлен язык ${effectiveLanguage} — требуется перепроверка прав`,
          descriptionRu: `К книге добавлена новая языковая версия (${effectiveLanguage}). Права на перевод и связанные компоненты не покрыты действующей проверкой.`,
        });
      } catch (e: unknown) {
        this.logger.warn(
          `Failed to open LANGUAGE_ADDED recheck task: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    }

    return version;
  }

  async getPublic(id: string, countryCode: string | null = null) {
    const version = await this.prisma.bookVersion.findFirst({
      where: { id, status: 'published' },
      include: {
        seo: true,
        categories: {
          include: { category: true },
        },
        tags: {
          include: { tag: true },
        },
      },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    await this.geoBlockRuleService.assertAccess({
      bookVersionId: id,
      countryCode,
      scope: GeoBlockScope.LANGUAGE_EDITION,
    });
    return {
      ...version,
      categories: version.categories.map((c) => c.category),
      tags: version.tags.map((t) => t.tag),
    };
  }

  // Админский доступ — любая версия
  async getAdmin(id: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id },
      include: {
        seo: true,
        book: {
          select: {
            id: true,
            slug: true,
            rightsIntakeId: true,
            currentRightsProfileId: true,
            approvedRightsReviewId: true,
            rightsCreatedAt: true,
          },
        },
        categories: {
          include: { category: true },
        },
        tags: {
          include: { tag: true },
        },
      },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    // Добавляем bookSlug к результату
    return {
      ...version,
      bookSlug: version.book.slug,
      categories: version.categories.map((c) => c.category),
      tags: version.tags.map((t) => t.tag),
    };
  }

  async getRightsDashboard(versionId: string): Promise<BookRightsDashboardDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      include: {
        book: {
          select: {
            id: true,
            slug: true,
            rightsIntakeId: true,
            currentRightsProfileId: true,
            approvedRightsReviewId: true,
            rightsCreatedAt: true,
          },
        },
      },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    const versionRecord = version as unknown as Record<string, unknown>;

    const bookVersions = await this.prisma.bookVersion.findMany({
      where: { bookId: version.bookId },
      select: {
        id: true,
        language: true,
        type: true,
        status: true,
        title: true,
        rightsProfileId: true,
        approvedRightsReviewId: true,
        rightsStatus: true,
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
        rightsRecheckRequired: true,
        rightsStaleDetectedAt: true,
      },
    });

    const intakeId = version.book.rightsIntakeId;
    let intake: Record<string, unknown> | null = null;
    let approvalHistory: Record<string, unknown>[] = [];
    if (intakeId) {
      const foundIntake = await this.prisma.rightsIntake.findUnique({
        where: { id: intakeId },
      });
      intake = (foundIntake as Record<string, unknown> | null) || null;

      const foundApprovals = await this.prisma.rightsReviewApproval.findMany({
        where: { rightsIntakeId: intakeId },
        orderBy: { createdAt: 'desc' },
      });
      approvalHistory = (foundApprovals as Record<string, unknown>[]) || [];
    }

    const profileId = version.rightsProfileId || version.book.currentRightsProfileId;
    let currentProfile: Record<string, unknown> | null = null;
    let reviewHistory: Record<string, unknown>[] = [];
    let approvedReview: Record<string, unknown> | null = null;

    if (profileId) {
      const foundProfile = await this.prisma.rightsProfile.findUnique({
        where: { id: profileId },
        include: {
          sourceEdition: {
            include: {
              editionRights: true,
            },
          },
          components: {
            include: {
              territoryAssessments: {
                orderBy: [{ countryCode: 'asc' }],
              },
            },
          },
          territoryDecisions: true,
          evidence: true,
          actions: true,
          contributors: {
            include: {
              person: true,
            },
          },
        } as any,
      });
      if (foundProfile) {
        currentProfile = foundProfile as Record<string, unknown>;
        const foundReviews = await this.prisma.rightsReview.findMany({
          where: { rightsProfileId: profileId },
          include: {
            rightsReviewImport: true,
          },
          orderBy: { createdAt: 'desc' },
        });
        reviewHistory = (foundReviews as Record<string, unknown>[]) || [];
        const approvedId = version.approvedRightsReviewId || version.book.approvedRightsReviewId;
        if (approvedId) {
          approvedReview =
            reviewHistory.find((r) => r['id'] === approvedId) || reviewHistory[0] || null;
        } else {
          approvedReview = reviewHistory[0] || null;
        }
      }
    }

    const publicationGate = await this.publicationGateService.checkVersionCanPublish(versionId);
    const contentHash = await this.rightsContentHashService.checkVersionStaleness(
      versionId,
      'MANUAL_HASH_CHECK',
    );

    const hasClearance = !!intakeId || !!profileId;
    const canPublishCurrentVersion = publicationGate.canPublish;

    const territoryDecisions =
      (currentProfile?.['territoryDecisions'] as Array<Record<string, unknown>>) || [];
    const actions = (currentProfile?.['actions'] as Array<Record<string, unknown>>) || [];
    const components = (currentProfile?.['components'] as Array<Record<string, unknown>>) || [];
    const evidence = (currentProfile?.['evidence'] as Array<Record<string, unknown>>) || [];
    const componentTerritoryAssessments = components.flatMap((component) =>
      Array.isArray(component['territoryAssessments'])
        ? (component['territoryAssessments'] as Array<Record<string, unknown>>)
        : [],
    );

    const blockedCountriesCount = territoryDecisions.filter(
      (t) => t['finalStatus'] === 'BLOCKED' || t['accessPolicy'] === 'BLOCK',
    ).length;
    const licenseRequiredCountriesCount = territoryDecisions.filter(
      (t) => t['finalStatus'] === 'LICENSE_REQUIRED',
    ).length;
    const pendingCountriesCount = territoryDecisions.filter(
      (t) =>
        t['finalStatus'] === 'PENDING_REVIEW' ||
        t['finalStatus'] === 'NOT_CHECKED' ||
        t['finalStatus'] === 'UNCERTAIN' ||
        t['finalStatus'] === 'PENDING',
    ).length;
    const geoBlockRequiredCount = territoryDecisions.filter((t) => t['geoBlockRequired']).length;
    const unresolvedBlockingActionsCount = actions.filter(
      (a) => a['isBlocking'] && a['status'] !== 'COMPLETED' && a['status'] !== 'WAIVED',
    ).length;
    const blockedComponentTerritoryAssessmentsCount = componentTerritoryAssessments.filter(
      (assessment) =>
        assessment['accessPolicy'] === 'BLOCK' || assessment['geoBlockRequired'] === true,
    ).length;
    const reviewRequiredComponentTerritoryAssessmentsCount = componentTerritoryAssessments.filter(
      (assessment) => assessment['accessPolicy'] === 'REVIEW_REQUIRED',
    ).length;
    const componentAssessmentExpiryThreshold = new Date();
    componentAssessmentExpiryThreshold.setDate(componentAssessmentExpiryThreshold.getDate() + 180);
    const now = new Date();
    const expiringComponentTerritoryAssessmentsCount = componentTerritoryAssessments.filter(
      (assessment) => {
        if (!assessment['rightsExpireAt']) return false;
        const rightsExpireAt = new Date(assessment['rightsExpireAt'] as string);
        return rightsExpireAt >= now && rightsExpireAt <= componentAssessmentExpiryThreshold;
      },
    ).length;

    const isStale =
      !!version.rightsStaleDetectedAt || !contentHash.matchesBaseline || contentHash.isStale;
    const recheckRequired = version.rightsRecheckRequired || contentHash.recheckRequired;

    // WP-C.4: план публикации берётся из интейка версии — региональная сводка отдаёт долю
    // и по справочнику региона, и по целевым странам.
    const intakeTargetCountryCodes = Array.isArray(intake?.['targetCountryCodes'])
      ? (intake['targetCountryCodes'] as unknown[]).filter(
          (countryCode): countryCode is string => typeof countryCode === 'string',
        )
      : [];

    const regionalTerritorySummary =
      (currentProfile?.['regionalTerritorySummary'] as Array<Record<string, unknown>>) ||
      (this.regionAggregationService?.aggregateTerritoryDecisions(
        territoryDecisions,
        intakeTargetCountryCodes,
      ) as unknown as Array<Record<string, unknown>>) ||
      [];

    const profileContributors =
      (currentProfile?.['contributors'] as Array<Record<string, unknown>>) || [];
    const contributorsCount = profileContributors.length;
    const authorsCount = profileContributors.filter((c) => c['role'] === 'AUTHOR').length;
    const translatorsCount = profileContributors.filter((c) => c['role'] === 'TRANSLATOR').length;
    const narratorsCount = profileContributors.filter((c) => c['role'] === 'NARRATOR').length;
    const contributorsWithoutPersonCount = profileContributors.filter((c) => !c['personId']).length;

    // Phase 15: licenses reachable from the profile plus the version's own coverage
    const profileLicenses = profileId
      ? await this.licenseCoverageService.loadLicensesForProfile(profileId)
      : [];
    const licenseCoverage = await this.licenseCoverageService.evaluateVersionCoverage(versionId);
    const licenseCheckedAt = new Date();
    const licenseSummaries = profileLicenses.map((license) => ({
      id: license.id,
      title: license.title,
      licensor: license.licensor,
      licenseType: license.licenseType,
      status: license.status,
      effectiveStatus: this.licenseCoverageService.effectiveStatus(license, licenseCheckedAt),
      territoryScope: license.territoryScope,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      isPerpetual: license.isPerpetual,
      attributionRequired: license.attributionRequired,
    }));

    const activeLicensesCount = licenseSummaries.filter(
      (l) => l.effectiveStatus === RightsLicenseStatus.ACTIVE,
    ).length;
    const expiredLicensesCount = licenseSummaries.filter(
      (l) => l.effectiveStatus === RightsLicenseStatus.EXPIRED,
    ).length;
    const revokedLicensesCount = licenseSummaries.filter(
      (l) => l.effectiveStatus === RightsLicenseStatus.REVOKED,
    ).length;
    const expiringSoonLicensesCount = profileLicenses.filter((license) => {
      if (license.isPerpetual || !license.expiresAt) return false;
      if (!this.licenseCoverageService.isActiveAt(license, licenseCheckedAt)) return false;
      const daysLeft =
        (license.expiresAt.getTime() - licenseCheckedAt.getTime()) / (24 * 60 * 60 * 1000);
      return daysLeft >= 0 && daysLeft <= 90;
    }).length;
    const attributionRequiredLicensesCount = licenseSummaries.filter(
      (l) => l.attributionRequired,
    ).length;

    // Phase 16: claims filed against this version or against the whole book
    const claimList = await this.rightsClaimsService.listForVersion(versionId);
    const claims = claimList.items.slice(0, 50);
    const openClaims = claims.filter((claim) => claim.isOpen);
    const claimBlockedCountries = new Set<string>();
    for (const claim of claims) {
      for (const code of claim.blockedCountryCodes) claimBlockedCountries.add(code);
    }
    const activeClaimBlocksCount = claims.reduce(
      (total, claim) => total + claim.activeBlocksCount,
      0,
    );
    const worstClaimSeverity =
      openClaims.reduce<string | null>((worst, claim) => {
        const rank = CLAIM_SEVERITY_RANK[claim.severity] ?? 0;
        const worstRank = worst ? (CLAIM_SEVERITY_RANK[worst] ?? 0) : -1;
        return rank > worstRank ? claim.severity : worst;
      }, null) ?? null;

    // Phase 18: recheck tasks and schedule of this version and its rights profile.
    // Phase 8's `isStale` / `recheckRequired` above stay untouched — they describe content hash.
    const versionRecheck = await this.rightsRecheckService.getVersionRecheck(versionId);

    // Phase 19: legal review state. Wrapped in try/catch like the claims and recheck blocks —
    // a failure of the legal section must not take down the whole dashboard.
    let versionLawyerReview: VersionLawyerReviewDto | null = null;
    try {
      versionLawyerReview = await this.rightsLawyerReviewService.getVersionLawyerReview(versionId);
    } catch {
      versionLawyerReview = null;
    }

    if (currentProfile) {
      currentProfile = {
        ...currentProfile,
        regionalTerritorySummary,
        licenses: licenseSummaries,
        licenseCoverage,
      };
    }

    const regionCount = regionalTerritorySummary.length;
    const blockedRegionCount = regionalTerritorySummary.filter(
      (r) => r['status'] === 'BLOCKED',
    ).length;
    const licenseRequiredRegionCount = regionalTerritorySummary.filter(
      (r) => r['status'] === 'LICENSE_REQUIRED',
    ).length;
    const pendingReviewRegionCount = regionalTerritorySummary.filter(
      (r) => r['status'] === 'PENDING_REVIEW',
    ).length;
    const mixedRegionCount = regionalTerritorySummary.filter((r) => r['status'] === 'MIXED').length;
    const notTargetedRegionCount = regionalTerritorySummary.filter(
      (r) => r['status'] === 'NOT_TARGETED',
    ).length;

    // WP-1.2а. A version whose market restrictions are mandatory is only actually restricted while
    // the upstream proxy keeps sending a country. NO_DATA is left silent on purpose: right after a
    // restart there is nothing to judge by, and a warning that fires on every deploy stops being read.
    const geoCountrySource = this.geoIpCountryService?.getSourceHealth() ?? null;
    const geoCountrySourceWarning =
      version.rightsGeoBlockRequired &&
      (geoCountrySource?.status === GeoCountrySourceStatus.DEGRADED ||
        geoCountrySource?.status === GeoCountrySourceStatus.UNAVAILABLE);

    return {
      book: {
        id: version.book.id,
        slug: version.book.slug,
        rightsIntakeId: version.book.rightsIntakeId,
        currentRightsProfileId: version.book.currentRightsProfileId,
        approvedRightsReviewId: version.book.approvedRightsReviewId,
        rightsCreatedAt: version.book.rightsCreatedAt
          ? version.book.rightsCreatedAt.toISOString()
          : null,
      },
      currentVersion: {
        id: version.id,
        language: version.language,
        type: version.type,
        status: version.status,
        rightsProfileId: version.rightsProfileId,
        approvedRightsReviewId: version.approvedRightsReviewId,
        rightsStatus: version.rightsStatus,
        rightsGeoBlockRequired: version.rightsGeoBlockRequired,
        rightsGeoBlockConfigured: version.rightsGeoBlockConfigured,
        rightsGeoBlockConfiguredAt: version.rightsGeoBlockConfiguredAt
          ? version.rightsGeoBlockConfiguredAt.toISOString()
          : null,
        rightsGeoBlockNotesRu: version.rightsGeoBlockNotesRu,
        rightsGeoBlockVerifiedAt: versionRecord['rightsGeoBlockVerifiedAt']
          ? (versionRecord['rightsGeoBlockVerifiedAt'] as Date).toISOString()
          : null,
        rightsGeoBlockVerifiedByUserId:
          (versionRecord['rightsGeoBlockVerifiedByUserId'] as string | null) ?? null,
        rightsGeoBlockLastGeneratedAt: versionRecord['rightsGeoBlockLastGeneratedAt']
          ? (versionRecord['rightsGeoBlockLastGeneratedAt'] as Date).toISOString()
          : null,
        rightsContentHash: version.rightsContentHash,
        rightsContentHashAlgorithmVersion: version.rightsContentHashAlgorithmVersion,
        rightsContentHashCalculatedAt: version.rightsContentHashCalculatedAt
          ? version.rightsContentHashCalculatedAt.toISOString()
          : null,
        rightsRecheckRequired: version.rightsRecheckRequired,
        rightsStaleDetectedAt: version.rightsStaleDetectedAt
          ? version.rightsStaleDetectedAt.toISOString()
          : null,
        rightsStaleReasonCode: version.rightsStaleReasonCode,
        rightsStaleReasonRu: version.rightsStaleReasonRu,
        rightsLicenseCoverageStatus:
          (versionRecord['rightsLicenseCoverageStatus'] as string | null) ?? null,
        rightsLicenseCheckedAt: versionRecord['rightsLicenseCheckedAt']
          ? (versionRecord['rightsLicenseCheckedAt'] as Date).toISOString()
          : null,
        rightsLicenseIds: Array.isArray(versionRecord['rightsLicenseIds'])
          ? (versionRecord['rightsLicenseIds'] as string[])
          : null,
        rightsClaimBlockActive: versionRecord['rightsClaimBlockActive'] === true,
        rightsClaimBlockAppliedAt: versionRecord['rightsClaimBlockAppliedAt']
          ? (versionRecord['rightsClaimBlockAppliedAt'] as Date).toISOString()
          : null,
      },
      claims,
      versions: bookVersions.map((v) => ({
        id: v.id,
        language: v.language,
        type: v.type,
        status: v.status,
        title: v.title,
        rightsProfileId: v.rightsProfileId,
        approvedRightsReviewId: v.approvedRightsReviewId,
        rightsStatus: v.rightsStatus,
        rightsGeoBlockRequired: v.rightsGeoBlockRequired,
        rightsGeoBlockConfigured: v.rightsGeoBlockConfigured,
        rightsRecheckRequired: v.rightsRecheckRequired,
        rightsStaleDetectedAt: v.rightsStaleDetectedAt
          ? v.rightsStaleDetectedAt.toISOString()
          : null,
      })),
      intake,
      currentProfile,
      approvedReview,
      reviewHistory,
      approvalHistory,
      publicationGate,
      contentHash,
      recheckTasks: versionRecheck.tasks,
      recheckSchedule: versionRecheck.schedule,
      lawyerReviews: versionLawyerReview?.reviews ?? [],
      pendingLawyerConditions: versionLawyerReview?.pendingConditions ?? [],
      geoCountrySource,
      summary: {
        hasClearance,
        canPublishCurrentVersion,
        publicationGate: canPublishCurrentVersion ? 'ALLOW' : 'BLOCK',
        overallStatus: (currentProfile?.['overallStatus'] as string | null) || null,
        confidence: (currentProfile?.['confidence'] as string | null) || null,
        blockedCountriesCount,
        licenseRequiredCountriesCount,
        pendingCountriesCount,
        geoBlockRequiredCount,
        unresolvedBlockingActionsCount,
        evidenceCount: evidence.length,
        componentsCount: components.length,
        componentTerritoryAssessmentsCount: componentTerritoryAssessments.length,
        blockedComponentTerritoryAssessmentsCount,
        reviewRequiredComponentTerritoryAssessmentsCount,
        expiringComponentTerritoryAssessmentsCount,
        reviewsCount: reviewHistory.length,
        isStale,
        recheckRequired,
        contributorsCount,
        authorsCount,
        translatorsCount,
        narratorsCount,
        contributorsWithoutPersonCount,
        regionCount,
        blockedRegionCount,
        licenseRequiredRegionCount,
        pendingReviewRegionCount,
        mixedRegionCount,
        notTargetedRegionCount,
        licensesCount: licenseSummaries.length,
        activeLicensesCount,
        expiredLicensesCount,
        revokedLicensesCount,
        expiringSoonLicensesCount,
        attributionRequiredLicensesCount,
        licenseCoverageStatus: licenseCoverage.status,
        licenseCoveredCountriesCount: licenseCoverage.coveredCountryCodes.length,
        licenseUncoveredCountriesCount: licenseCoverage.uncoveredCountryCodes.length,
        claimsCount: claims.length,
        activeClaimsCount: openClaims.length,
        blockingClaimsCount: openClaims.filter((claim) => claim.blocksPublication).length,
        criticalClaimsCount: openClaims.filter(
          (claim) => claim.severity === RightsClaimSeverity.CRITICAL,
        ).length,
        overdueClaimsCount: openClaims.filter((claim) => claim.isOverdue).length,
        activeClaimBlocksCount,
        claimBlockedCountriesCount: claimBlockedCountries.size,
        hasWorldwideClaimBlock: claims.some((claim) => claim.hasWorldwideBlock),
        worstClaimSeverity,
        openRecheckTasksCount: versionRecheck.openTasksCount,
        overdueRecheckTasksCount: versionRecheck.overdueTasksCount,
        blockingRecheckTasksCount: versionRecheck.blockingTasksCount,
        nextRecheckDueAt: versionRecheck.nextRecheckDueAt,
        lastRecheckScanAt: versionRecheck.schedule?.lastRecheckScanAt ?? null,
        recheckPolicy: versionRecheck.schedule?.recheckPolicy ?? null,
        riskLevel: versionLawyerReview?.riskLevel ?? null,
        lawyerReviewRequired: versionLawyerReview?.lawyerReviewRequired ?? false,
        lawyerApproved: versionLawyerReview?.lawyerApproved ?? false,
        lawyerApprovedAt: versionLawyerReview?.lawyerApprovedAt ?? null,
        lawyerApprovedLawyerName: versionLawyerReview?.lawyerApprovedLawyerName ?? null,
        lawyerOpinionValidUntil: versionLawyerReview?.lawyerOpinionValidUntil ?? null,
        openLawyerReviewsCount: versionLawyerReview?.openReviewsCount ?? 0,
        pendingLawyerConditionsCount: versionLawyerReview?.pendingConditionsCount ?? 0,
        lawyerReviewsCount: versionLawyerReview?.reviews.length ?? 0,
        geoCountrySourceWarning,
      },
    };
  }

  async update(id: string, dto: UpdateBookVersionDto) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    if (dto.previewMediaId) {
      const media = await this.prisma.mediaAsset.findUnique({
        where: { id: dto.previewMediaId },
        select: { id: true, contentType: true, isDeleted: true },
      });
      if (!media || media.isDeleted) {
        throw new BadRequestException('previewMediaId references a non-existent MediaAsset');
      }
      if (!media.contentType || !media.contentType.startsWith('audio/')) {
        throw new BadRequestException('previewMediaId must reference an audio MediaAsset');
      }
    }

    const hasNonSeoFields = Object.keys(dto).some(
      (k) => k !== 'seoMetaTitle' && k !== 'seoMetaDescription',
    );

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        let seoId = existing.seoId;
        if (dto.seoMetaTitle !== undefined || dto.seoMetaDescription !== undefined) {
          if (seoId) {
            await tx.seo.update({
              where: { id: seoId },
              data: {
                metaTitle: dto.seoMetaTitle,
                metaDescription: dto.seoMetaDescription,
              },
            });
          } else {
            const seo = await tx.seo.create({
              data: {
                metaTitle: dto.seoMetaTitle,
                metaDescription: dto.seoMetaDescription,
              },
            });
            seoId = seo.id;
          }
        }
        // Убираем SEO поля из DTO, так как они не существуют в BookVersion schema
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { seoMetaTitle, seoMetaDescription, ...updateData } = dto;
        const updated = await tx.bookVersion.update({
          where: { id },
          data: {
            ...updateData,
            seoId,
          },
          include: { seo: true },
        });

        // Phase 8: Stale detection - skip if only SEO fields changed
        if (hasNonSeoFields) {
          await this.rightsContentHashService.checkVersionStaleness(
            id,
            'BOOK_VERSION_UPDATED',
            null,
            true,
            tx,
          );
        }

        return updated;
      });

      return updated;
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Version for this language already exists for this book');
      }
      throw e;
    }
  }

  async getPreview(id: string, countryCode: string | null = null) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id },
      select: {
        status: true,
        previewMediaId: true,
        previewMedia: {
          select: { url: true, duration: true, contentType: true, isDeleted: true },
        },
      },
    });
    if (!version || version.status !== 'published') {
      throw new NotFoundException('Version not found');
    }
    if (!version.previewMediaId || !version.previewMedia || version.previewMedia.isDeleted) {
      throw new NotFoundException('Preview not available');
    }
    await this.geoBlockRuleService.assertAccess({
      bookVersionId: id,
      mediaAssetId: version.previewMediaId,
      countryCode,
      scope: GeoBlockScope.AUDIO,
    });
    await this.geoBlockRuleService.assertAccess({
      bookVersionId: id,
      mediaAssetId: version.previewMediaId,
      countryCode,
      scope: GeoBlockScope.DOWNLOADS,
    });
    return {
      previewUrl: version.previewMedia.url,
      duration: version.previewMedia.duration,
      contentType: version.previewMedia.contentType,
    };
  }

  async remove(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.delete({
      where: { id },
      include: { seo: true },
    });
  }

  async publish(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');

    await this.publicationGateService.assertVersionCanPublish(id);

    // Phase 15: record which licenses justified this publication, so a later revocation
    // or expiry can be traced back to what was relied on at publish time.
    const coverage = await this.licenseCoverageService.evaluateVersionCoverage(id);
    const existingAttribution = (existing as unknown as { rightsLicenseAttributionTextRu?: string })
      .rightsLicenseAttributionTextRu;

    // WP-D.4: жёсткий выход из окна наполнения черновика. Публикация фиксирует слепок контента
    // окончательно и в той же транзакции пишет событие закрытия окна (ADR-009), после которого
    // правка главы снова уводит клиренс в `STALE`.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.bookVersion.update({
        where: { id },
        data: {
          status: 'published',
          publishedAt: new Date(),
          rightsLicenseIds: coverage.licenseIds,
          rightsLicenseCoverageStatus: coverage.status,
          rightsLicenseCheckedAt: new Date(),
          rightsLicenseUncoveredCountryCodes: coverage.uncoveredCountryCodes,
          rightsLicenseAttributionTextRu:
            existingAttribution && existingAttribution.trim() !== ''
              ? existingAttribution
              : coverage.attributionTextsRu.join('\n') || null,
        } as unknown as Prisma.BookVersionUpdateInput,
        include: { seo: true },
      });

      await this.rightsContentHashService.finalizeBaselineOnPublish(id, null, tx);

      return updated;
    });
  }

  async unpublish(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.update({
      where: { id },
      data: { status: 'draft', publishedAt: null },
      include: { seo: true },
    });
  }

  // Админский листинг без фильтра по статусу
  async listAdmin(
    bookId: string,
    filters: { language?: Language; type?: BookType; isFree?: boolean },
  ) {
    const where: Prisma.BookVersionWhereInput = {
      bookId,
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
    };
    return this.prisma.bookVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { seo: true },
    });
  }

  private bvcModelOf(client: Prisma.TransactionClient | PrismaService) {
    return (client as unknown as Record<string, unknown>)['bookVersionContributor'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      count: (args: Record<string, unknown>) => Promise<number>;
    };
  }

  private get bvcModel() {
    return this.bvcModelOf(this.prisma);
  }

  private get personModel() {
    return (this.prisma as unknown as Record<string, unknown>)['person'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  public async getVersionContributors(versionId: string) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`BookVersion with ID "${versionId}" not found`);

    return this.bvcModel.findMany({
      where: { bookVersionId: versionId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        person: true,
      },
    });
  }

  public async addVersionContributor(versionId: string, dto: CreateBookVersionContributorDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`BookVersion with ID "${versionId}" not found`);

    const person = await this.personModel.findUnique({ where: { id: dto.personId } });
    if (!person) throw new NotFoundException(`Person with ID "${dto.personId}" not found`);

    // WP-8.1: участник входит в content hash, поэтому смена состава участников проверяется
    // на устаревание клиренса в той же транзакции, что и сама запись.
    return this.prisma.$transaction(async (tx) => {
      const created = await this.bvcModelOf(tx).create({
        data: {
          bookVersionId: versionId,
          personId: dto.personId,
          role: dto.role,
          roleOtherRu: dto.roleOtherRu || null,
          displayOrder: dto.displayOrder ?? 0,
          isPrimary: dto.isPrimary ?? false,
          creditedName: dto.creditedName || null,
          creditedLanguage: dto.creditedLanguage || null,
          contributionNoteRu: dto.contributionNoteRu || null,
          confidence: dto.confidence || null,
        },
        include: {
          person: true,
        },
      });

      await this.rightsContentHashService.checkVersionStaleness(
        versionId,
        'VERSION_CONTRIBUTOR_CHANGED',
        null,
        true,
        tx,
      );

      return created;
    });
  }

  public async updateVersionContributor(
    versionId: string,
    contributorId: string,
    dto: UpdateBookVersionContributorDto,
  ) {
    const existing = await this.bvcModel.findFirst({
      where: { id: contributorId, bookVersionId: versionId },
    });
    if (!existing) {
      throw new NotFoundException(
        `BookVersionContributor with ID "${contributorId}" not found for version "${versionId}"`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await this.bvcModelOf(tx).update({
        where: { id: contributorId },
        data: {
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.roleOtherRu !== undefined ? { roleOtherRu: dto.roleOtherRu || null } : {}),
          ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
          ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
          ...(dto.creditedName !== undefined ? { creditedName: dto.creditedName || null } : {}),
          ...(dto.creditedLanguage !== undefined
            ? { creditedLanguage: dto.creditedLanguage || null }
            : {}),
          ...(dto.contributionNoteRu !== undefined
            ? { contributionNoteRu: dto.contributionNoteRu || null }
            : {}),
          ...(dto.confidence !== undefined ? { confidence: dto.confidence || null } : {}),
        },
        include: {
          person: true,
        },
      });

      await this.rightsContentHashService.checkVersionStaleness(
        versionId,
        'VERSION_CONTRIBUTOR_CHANGED',
        null,
        true,
        tx,
      );

      return updated;
    });
  }

  public async removeVersionContributor(versionId: string, contributorId: string) {
    const existing = await this.bvcModel.findFirst({
      where: { id: contributorId, bookVersionId: versionId },
    });
    if (!existing) {
      throw new NotFoundException(
        `BookVersionContributor with ID "${contributorId}" not found for version "${versionId}"`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.bvcModelOf(tx).delete({
        where: { id: contributorId },
      });

      await this.rightsContentHashService.checkVersionStaleness(
        versionId,
        'VERSION_CONTRIBUTOR_CHANGED',
        null,
        true,
        tx,
      );
    });

    let warning: string | undefined = undefined;
    if (existing['role'] === ContributorRole.AUTHOR && existing['isPrimary']) {
      const remainingAuthors = await this.bvcModel.count({
        where: { bookVersionId: versionId, role: ContributorRole.AUTHOR },
      });
      if (remainingAuthors === 0) {
        warning =
          'Removed the primary AUTHOR contributor. Note that legacy BookVersion.author string remains unchanged.';
      }
    }

    return { success: true, warning };
  }

  public async reorderVersionContributors(
    versionId: string,
    dto: ReorderBookVersionContributorsDto,
  ) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException(`BookVersion with ID "${versionId}" not found`);

    await Promise.all(
      dto.contributorIds.map((id, index) =>
        this.bvcModel.updateMany({
          where: { id, bookVersionId: versionId },
          data: { displayOrder: index },
        }),
      ),
    );

    return this.getVersionContributors(versionId);
  }
}
