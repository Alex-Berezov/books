import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';

interface BookWithRights {
  id: string;
  rightsIntakeId: string | null;
  currentRightsProfileId: string | null;
  approvedRightsReviewId: string | null;
}

interface RightsIntakeWithLanguages {
  id: string;
  targetLanguages: string[];
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
  constructor(
    private prisma: PrismaService,
    private publicationGateService: PublicationGateService,
    private rightsContentHashService: RightsContentHashService,
    private geoBlockRuleService: GeoBlockRuleService,
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

    // Check if language is in approved target languages
    if (
      rightsIntake?.targetLanguages &&
      !rightsIntake.targetLanguages.includes(effectiveLanguage)
    ) {
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

        // Copy geo-block fields from sibling or compute from profile/context
        const rightsGeoBlockRequired = siblingVersion?.rightsGeoBlockRequired ?? false;
        const rightsGeoBlockConfigured = siblingVersion?.rightsGeoBlockConfigured ?? false;
        const rightsGeoBlockConfiguredAt = siblingVersion?.rightsGeoBlockConfiguredAt ?? null;
        const rightsGeoBlockNotesRu = siblingVersion?.rightsGeoBlockNotesRu ?? null;

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
          } as Prisma.BookVersionUncheckedCreateInput & {
            rightsGeoBlockRequired: boolean;
            rightsGeoBlockConfigured: boolean;
            rightsGeoBlockConfiguredAt: Date | null;
            rightsGeoBlockNotesRu: string | null;
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
        },
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

    const regionalTerritorySummary =
      (currentProfile?.['regionalTerritorySummary'] as Array<Record<string, unknown>>) ||
      (this.regionAggregationService?.aggregateTerritoryDecisions(
        territoryDecisions,
      ) as unknown as Array<Record<string, unknown>>) ||
      [];

    if (currentProfile) {
      currentProfile = {
        ...currentProfile,
        regionalTerritorySummary,
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
      },
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
        regionCount,
        blockedRegionCount,
        licenseRequiredRegionCount,
        pendingReviewRegionCount,
        mixedRegionCount,
        notTargetedRegionCount,
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

    return this.prisma.bookVersion.update({
      where: { id },
      data: { status: 'published', publishedAt: new Date() },
      include: { seo: true },
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

  private get bvcModel() {
    return (this.prisma as unknown as Record<string, unknown>)['bookVersionContributor'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      count: (args: Record<string, unknown>) => Promise<number>;
    };
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

    return this.bvcModel.create({
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

    return this.bvcModel.update({
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

    await this.bvcModel.delete({
      where: { id: contributorId },
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
