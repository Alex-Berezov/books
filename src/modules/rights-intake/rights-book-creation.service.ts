import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyTerritoryDecisions } from '../rights-clearance/rights-clearance.util';
import { CreateBookFromClearanceDto } from './dto/create-book-from-clearance.dto';
import { CreateBookFromClearanceResponseDto } from './dto/create-book-from-clearance-response.dto';
import { RightsContentHashService } from './rights-content-hash.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class RightsBookCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rightsContentHashService: RightsContentHashService,
    private readonly licenseCoverageService: RightsLicenseCoverageService,
  ) {}

  private get ri() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsIntake'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get rr() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReview'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get rp() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsProfile'] as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get ra() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsAction'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  private get td() {
    return (this.prisma as unknown as Record<string, unknown>)['territoryDecision'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  async createBookFromApprovedClearance(
    intakeId: string,
    dto: CreateBookFromClearanceDto,
  ): Promise<CreateBookFromClearanceResponseDto> {
    // 1. Find RightsIntake
    const intake = await this.ri.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`RightsIntake with ID '${intakeId}' not found`);
    }

    // 2. Check intake status is APPROVED
    if (intake['workflowStatus'] !== 'APPROVED') {
      throw new BadRequestException(
        `Cannot create book: intake status is '${String(intake['workflowStatus'])}', expected 'APPROVED'`,
      );
    }

    // 3. Check approvedReviewId exists
    const approvedReviewId = intake['approvedReviewId'] as string | null;
    if (!approvedReviewId) {
      throw new BadRequestException('Cannot create book: intake has no approved review');
    }

    // 4. Check createdBookId is null (book not already created)
    if (intake['createdBookId']) {
      throw new BadRequestException('Cannot create book: book already created for this intake');
    }

    // 5. Find approved RightsReview
    const review = await this.rr.findUnique({
      where: { id: approvedReviewId },
      include: { rightsProfile: true },
    });
    if (!review) {
      throw new NotFoundException(`Approved RightsReview with ID '${approvedReviewId}' not found`);
    }

    // 6. Check review status is HUMAN_APPROVED
    if (review['status'] !== 'HUMAN_APPROVED') {
      throw new BadRequestException(
        `Cannot create book: review status is '${String(review['status'])}', expected 'HUMAN_APPROVED'`,
      );
    }

    // 7. Find current RightsProfile
    const profile = review['rightsProfile'] as Record<string, unknown>;
    const profileId = profile['id'] as string;
    const profileIntakeId = profile['rightsIntakeId'] as string;

    // 8. Check profile is current
    if (!profile['isCurrent']) {
      throw new BadRequestException('Cannot create book: rights profile is not current');
    }

    // 9. Check profile status is APPROVED
    if (profile['status'] !== 'APPROVED') {
      throw new BadRequestException(
        `Cannot create book: profile status is '${String(profile['status'])}', expected 'APPROVED'`,
      );
    }

    // 10. Check profile belongs to this intake
    if (profileIntakeId !== intakeId) {
      throw new BadRequestException('Cannot create book: profile belongs to different intake');
    }

    // 11. Check publicationGate is not BLOCK
    if (profile['publicationGate'] === 'BLOCK') {
      throw new BadRequestException('Cannot create book: publication gate is BLOCK');
    }

    // 12. Check for unresolved blocking actions
    const blockingActions = await this.ra.findMany({
      where: {
        rightsProfileId: profileId,
        isBlocking: true,
      },
    });

    const unresolvedBlocking = blockingActions.filter((a) => {
      const status = a['status'] as string;
      return status !== 'COMPLETED' && status !== 'WAIVED';
    });

    if (unresolvedBlocking.length > 0) {
      throw new BadRequestException(
        'Cannot create book: there are unresolved blocking rights actions',
      );
    }

    // 13. Check slug uniqueness
    const existingBook = await this.prisma.book.findUnique({ where: { slug: dto.slug } });
    if (existingBook) {
      throw new ConflictException(`Book with slug '${dto.slug}' already exists`);
    }

    // 14. Validate versions against targetLanguages
    const targetLanguages = intake['targetLanguages'] as string[];
    for (const version of dto.versions) {
      if (!targetLanguages.includes(version.language)) {
        throw new BadRequestException(
          `Cannot create version for language '${version.language}': not in target languages`,
        );
      }
    }

    // 15. Get territory decisions for rights snapshot
    const territoryDecisions = await this.td.findMany({
      where: { rightsProfileId: profileId },
    });

    // 16. Compute rights snapshot. Same classifier the read-side resolver uses, so the audit
    // snapshot and the clearance in force can only differ because the clearance changed.
    const {
      allowedCountryCodes: allowedCountries,
      blockedCountryCodes: blockedCountries,
      licenseRequiredCountryCodes: licenseRequiredCountries,
      pendingCountryCodes: pendingCountries,
    } = classifyTerritoryDecisions(
      territoryDecisions.map((td) => ({
        countryCode: td['countryCode'] as string,
        accessPolicy: td['accessPolicy'] as string,
        finalStatus: td['finalStatus'] as string,
      })),
    );

    // 17. Get required actions snapshot
    const actions = await this.ra.findMany({
      where: { rightsProfileId: profileId },
    });

    const requiredActions = actions.map((a) => ({
      id: a['id'] as string,
      actionType: a['actionType'] as string,
      status: a['status'] as string,
      descriptionRu: a['descriptionRu'] as string,
      affectedCountryCodes: a['affectedCountryCodes'] as string[],
      isBlocking: a['isBlocking'] as boolean,
    }));

    // 17b. Phase 15: evaluate license coverage per version (language and format differ)
    const licenses = await this.licenseCoverageService.loadLicensesForProfile(profileId);
    const checkedAt = new Date();
    const coverageByVersion = dto.versions.map((versionDto) =>
      this.licenseCoverageService.evaluateCoverage({
        requiredCountryCodes: licenseRequiredCountries,
        languageCode: versionDto.language,
        requiredMediaFormats: this.licenseCoverageService.mediaFormatsForVersionType(
          versionDto.type,
        ),
        licenses,
        at: checkedAt,
      }),
    );
    const allVersionsLicensed =
      licenseRequiredCountries.length > 0 &&
      coverageByVersion.length > 0 &&
      coverageByVersion.every((coverage) => coverage.status === 'COVERED');

    // 18. Compute rights status
    let rightsStatus = 'APPROVED';
    if (profile['publicationGate'] === 'ALLOW_AFTER_GEO_CONFIGURATION') {
      rightsStatus = 'APPROVED_WITH_GEO_RESTRICTIONS';
    } else if (allVersionsLicensed) {
      rightsStatus = 'APPROVED_WITH_LICENSES';
    } else if (licenseRequiredCountries.length > 0) {
      rightsStatus = 'APPROVED_WITH_LICENSE_LIMITATIONS';
    } else if (pendingCountries.length > 0) {
      rightsStatus = 'APPROVED_WITH_PENDING_TERRITORIES';
    }

    // 19. Create Book and BookVersions in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const bookTx = t['book'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const bvTx = t['bookVersion'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const riTx = t['rightsIntake'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      // Create Book
      const book = await bookTx.create({
        data: {
          slug: dto.slug,
          rightsIntakeId: intakeId,
          currentRightsProfileId: profileId,
          approvedRightsReviewId: approvedReviewId,
          rightsCreatedAt: new Date(),
        },
      });

      const bookId = book['id'] as string;

      // Create BookVersions
      const rllTx = t['rightsLicenseLink'] as {
        findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      const versions: Array<Record<string, unknown>> = [];
      for (let versionIndex = 0; versionIndex < dto.versions.length; versionIndex++) {
        const versionDto = dto.versions[versionIndex];
        const coverage = coverageByVersion[versionIndex];
        const version = await bvTx.create({
          data: {
            bookId,
            language: versionDto.language,
            title: versionDto.title,
            author: versionDto.author,
            description: versionDto.description,
            coverImageUrl: versionDto.coverImageUrl,
            type: versionDto.type,
            isFree: versionDto.isFree,
            referralUrl: versionDto.referralUrl ?? null,
            status: 'draft',
            rightsProfileId: profileId,
            approvedRightsReviewId: approvedReviewId,
            rightsStatus,
            rightsAllowedCountryCodes: allowedCountries,
            rightsBlockedCountryCodes: blockedCountries,
            rightsLicenseRequiredCountryCodes: licenseRequiredCountries,
            rightsPendingCountryCodes: pendingCountries,
            rightsRequiredActions: requiredActions,
            // Phase 7: Publication gate geo-block fields
            rightsGeoBlockRequired:
              blockedCountries.length > 0 ||
              profile['publicationGate'] === 'ALLOW_AFTER_GEO_CONFIGURATION',
            rightsGeoBlockConfigured: false,
            rightsGeoBlockConfiguredAt: null,
            rightsGeoBlockNotesRu: null,
            // Phase 15: license snapshot
            rightsLicenseIds: coverage.licenseIds,
            rightsLicenseCoverageStatus: coverage.status,
            rightsLicenseCheckedAt: checkedAt,
            rightsLicenseUncoveredCountryCodes: coverage.uncoveredCountryCodes,
            rightsLicenseAttributionTextRu: coverage.attributionTextsRu.join('\n') || null,
            originalLanguage:
              versionDto.originalLanguage ?? (intake['originalLanguage'] as string | null),
            originalTitle: versionDto.originalTitle ?? (intake['originalTitle'] as string | null),
            copyrightStatus: versionDto.copyrightStatus ?? rightsStatus,
            primaryCategoryId: versionDto.primaryCategoryId ?? null,
            firstPublishedYear: versionDto.firstPublishedYear ?? null,
            editionPublishedYear: versionDto.editionPublishedYear ?? null,
            authorPageUrl: versionDto.authorPageUrl ?? null,
            authorId: versionDto.authorId ?? null,
            shortDescription: versionDto.shortDescription ?? null,
            summaryShort: versionDto.summaryShort ?? null,
            coverAlt: versionDto.coverAlt ?? null,
          },
        });

        // Carry the licenses that justified this version onto the version itself, so the
        // publication gate can find them without walking back to the profile.
        for (const rightsLicenseId of coverage.licenseIds) {
          const existingLink = await rllTx.findFirst({
            where: { rightsLicenseId, bookVersionId: version['id'] as string },
          });
          if (existingLink) continue;

          await rllTx.create({
            data: {
              rightsLicenseId,
              linkType: 'BOOK_VERSION',
              bookVersionId: version['id'] as string,
            },
          });
        }

        versions.push(version);
      }

      // Phase 8: Initialize content hash baselines for all created versions
      for (const v of versions) {
        await this.rightsContentHashService.initializeVersionBaseline(
          v['id'] as string,
          'INITIAL_VERSION_SNAPSHOT',
          null,
          tx,
        );
        await this.projectContributorsToVersion(
          tx as unknown as Prisma.TransactionClient,
          v['id'] as string,
          v['language'] as string,
          v['type'] as string,
          profileId,
          (intake['originalLanguage'] as string) || undefined,
        );
      }

      // Update RightsIntake
      await riTx.update({
        where: { id: intakeId },
        data: {
          workflowStatus: 'BOOK_CREATED',
          createdBookId: bookId,
        },
      });

      return { book, versions };
    });

    const book = result.book;
    const versions = result.versions;

    return {
      book: {
        id: book['id'] as string,
        slug: book['slug'] as string,
        rightsIntakeId: book['rightsIntakeId'] as string | null,
        currentRightsProfileId: book['currentRightsProfileId'] as string | null,
        approvedRightsReviewId: book['approvedRightsReviewId'] as string | null,
        rightsCreatedAt: book['rightsCreatedAt']
          ? new Date(book['rightsCreatedAt'] as string).toISOString()
          : null,
        createdAt: new Date(book['createdAt'] as string).toISOString(),
        updatedAt: new Date(book['updatedAt'] as string).toISOString(),
      },
      versions: versions.map((v) => ({
        id: v['id'] as string,
        bookId: v['bookId'] as string,
        language: v['language'] as string,
        title: v['title'] as string,
        status: v['status'] as string,
        rightsStatus: v['rightsStatus'] as string | null,
      })),
      rightsProfileId: profileId,
      approvedRightsReviewId: approvedReviewId,
    };
  }

  private async projectContributorsToVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    versionLanguage: string,
    versionType: string,
    profileId: string,
    originalLanguage?: string,
  ) {
    const t = tx as unknown as Record<string, unknown>;
    const rpcModel = t['rightsProfileContributor'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const bvcModel = t['bookVersionContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const profileContributors =
      rpcModel && typeof rpcModel.findMany === 'function'
        ? await rpcModel.findMany({
            where: { rightsProfileId: profileId },
            include: {
              rightsComponent: true,
            },
          })
        : [];

    if (!profileContributors || profileContributors.length === 0) return;

    const seenKeys = new Set<string>();

    for (let index = 0; index < profileContributors.length; index++) {
      const pc = profileContributors[index];
      const personId = pc['personId'] as string | null;
      if (!personId) continue;

      const role = pc['role'] as string;
      const roleOtherRu = (pc['roleOtherRu'] as string) ?? null;
      const creditedName = (pc['creditedName'] as string) ?? (pc['displayName'] as string) ?? null;
      const confidence = (pc['confidence'] as string) ?? null;

      let shouldProject = false;
      let isPrimary = false;

      if (role === 'AUTHOR') {
        shouldProject = true;
        isPrimary = index === 0;
      } else if (role === 'TRANSLATOR') {
        const rc = pc['rightsComponent'] as Record<string, unknown> | null;
        const compType = rc ? (rc['componentType'] as string) || '' : '';
        const titleRu = rc ? (rc['titleRu'] as string) || '' : '';
        const creditedLang = (pc['creditedLanguage'] as string) || null;

        if (creditedLang) {
          shouldProject = creditedLang.toLowerCase() === versionLanguage.toLowerCase();
        } else if (compType === 'TEXT_TRANSLATION') {
          shouldProject =
            versionLanguage !== originalLanguage ||
            titleRu.toLowerCase().includes(versionLanguage.toLowerCase());
        } else {
          shouldProject = versionLanguage !== originalLanguage;
        }
      } else if (role === 'NARRATOR') {
        const typeLower = versionType ? versionType.toLowerCase() : '';
        shouldProject = typeLower === 'audio' || typeLower === 'audiobook';
      } else {
        shouldProject = true;
      }

      if (!shouldProject) continue;

      const dedupeKey = `${versionId}:${personId}:${role}:${creditedName || ''}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      await bvcModel.create({
        data: {
          bookVersionId: versionId,
          personId,
          role,
          roleOtherRu,
          displayOrder: index,
          isPrimary,
          creditedName,
          creditedLanguage: versionLanguage,
          confidence,
        },
      });
    }
  }
}
