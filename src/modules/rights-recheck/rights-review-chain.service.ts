import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RECHECK_ERROR_CODES } from './rights-recheck.constants';
import { recheckError } from './rights-recheck.errors';
import type {
  ReviewChainDiffDto,
  ReviewChainItemDto,
  ReviewChainResponseDto,
} from './dto/review-chain-response.dto';
import type {
  RecheckDatabaseClient,
  RecheckReviewRecord,
  RecheckTerritoryDecisionRecord,
} from './rights-recheck-interface';

const CHAIN_REVIEW_SELECT = {
  id: true,
  rightsProfileId: true,
  status: true,
  overallStatus: true,
  publicationGate: true,
  confidence: true,
  nextReviewAt: true,
  approvedAt: true,
  approvedByUserId: true,
  previousReviewId: true,
  chainRootReviewId: true,
  revisionNumber: true,
  rightsReviewImportId: true,
  createdAt: true,
  approvedByUser: { select: { id: true, name: true, email: true } },
  rightsProfile: { select: { isCurrent: true } },
} as const;

/**
 * Owns `previousReviewId` / `chainRootReviewId` / `revisionNumber`.
 *
 * `linkNewReview` is used by manual flows and tests; the import materialization performs
 * the same linking inline, because `RightsIntakeModule` cannot import this module
 * (that would be a dependency cycle). See §6.2 of the Phase 18 spec.
 */
@Injectable()
export class RightsReviewChainService {
  constructor(private readonly prisma: PrismaService) {}

  private getDatabase(): RecheckDatabaseClient {
    return this.prisma as unknown as RecheckDatabaseClient;
  }

  async getChainForIntake(intakeId: string): Promise<ReviewChainResponseDto> {
    const database = this.getDatabase();
    const intake = await database.rightsIntake.findUnique({
      where: { id: intakeId },
      select: { id: true, candidateTitle: true, workflowStatus: true },
    });
    if (!intake) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_INTAKE_NOT_FOUND);
    }

    const reviews = await database.rightsReview.findMany({
      where: { rightsProfile: { rightsIntakeId: intakeId } },
      orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
      select: CHAIN_REVIEW_SELECT,
    });

    return this.buildChain(database, reviews);
  }

  async getChainForProfile(profileId: string): Promise<ReviewChainResponseDto> {
    const database = this.getDatabase();
    const profile = await database.rightsProfile.findUnique({ where: { id: profileId } });
    if (!profile) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.RECHECK_PROFILE_NOT_FOUND);
    }

    const reviews = await database.rightsReview.findMany({
      where: { rightsProfileId: profileId },
      orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
      select: CHAIN_REVIEW_SELECT,
    });

    return this.buildChain(database, reviews);
  }

  /**
   * Links a freshly created review to the previous one of the same intake.
   * `previousReviewId` is `@unique`, so a duplicate link degrades to root-only bookkeeping.
   */
  async linkNewReview(
    client: RecheckDatabaseClient,
    input: { intakeId: string; newReviewId: string },
  ): Promise<void> {
    const previous = await client.rightsReview.findFirst({
      where: {
        rightsProfile: { rightsIntakeId: input.intakeId },
        id: { not: input.newReviewId },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, chainRootReviewId: true, revisionNumber: true },
    });

    const data = previous
      ? {
          previousReviewId: previous.id,
          chainRootReviewId: previous.chainRootReviewId ?? previous.id,
          revisionNumber: (previous.revisionNumber ?? 1) + 1,
        }
      : {
          previousReviewId: null,
          chainRootReviewId: input.newReviewId,
          revisionNumber: 1,
        };

    await client.rightsReview.update({ where: { id: input.newReviewId }, data });
  }

  private async buildChain(
    database: RecheckDatabaseClient,
    reviews: RecheckReviewRecord[],
  ): Promise<ReviewChainResponseDto> {
    if (reviews.length === 0) {
      return { items: [], total: 0 };
    }

    const profileIds = Array.from(new Set(reviews.map((review) => review.rightsProfileId)));
    const decisions = await database.territoryDecision.findMany({
      where: { rightsProfileId: { in: profileIds } },
      select: { rightsProfileId: true, countryCode: true, finalStatus: true },
    });

    const decisionsByProfile = new Map<string, RecheckTerritoryDecisionRecord[]>();
    for (const decision of decisions) {
      const bucket = decisionsByProfile.get(decision.rightsProfileId) ?? [];
      bucket.push(decision);
      decisionsByProfile.set(decision.rightsProfileId, bucket);
    }

    const items: ReviewChainItemDto[] = reviews.map((review, index) => {
      const previous = index > 0 ? reviews[index - 1] : null;
      return {
        id: review.id,
        revisionNumber: review.revisionNumber,
        previousReviewId: review.previousReviewId,
        chainRootReviewId: review.chainRootReviewId,
        status: review.status,
        overallStatus: review.overallStatus ?? '',
        publicationGate: review.publicationGate ?? '',
        confidence: review.confidence ?? '',
        nextReviewAt: review.nextReviewAt ? new Date(review.nextReviewAt).toISOString() : null,
        approvedAt: review.approvedAt ? new Date(review.approvedAt).toISOString() : null,
        approvedByUserId: review.approvedByUserId ?? null,
        approvedByUserName: review.approvedByUser?.name ?? review.approvedByUser?.email ?? null,
        rightsProfileId: review.rightsProfileId,
        rightsReviewImportId: review.rightsReviewImportId ?? '',
        isCurrent: review.rightsProfile?.isCurrent ?? false,
        createdAt: review.createdAt ? new Date(review.createdAt).toISOString() : '',
        diffFromPrevious: previous ? this.buildDiff(previous, review, decisionsByProfile) : null,
      };
    });

    return { items, total: items.length };
  }

  private buildDiff(
    previous: RecheckReviewRecord,
    current: RecheckReviewRecord,
    decisionsByProfile: Map<string, RecheckTerritoryDecisionRecord[]>,
  ): ReviewChainDiffDto {
    return {
      overallStatusChanged: previous.overallStatus !== current.overallStatus,
      publicationGateChanged: previous.publicationGate !== current.publicationGate,
      confidenceChanged: previous.confidence !== current.confidence,
      changedCountryCount: this.countChangedCountries(
        decisionsByProfile.get(previous.rightsProfileId) ?? [],
        decisionsByProfile.get(current.rightsProfileId) ?? [],
      ),
    };
  }

  /** Countries whose final status differs, plus countries present in only one of the two. */
  private countChangedCountries(
    previous: RecheckTerritoryDecisionRecord[],
    current: RecheckTerritoryDecisionRecord[],
  ): number {
    const previousByCountry = new Map(previous.map((item) => [item.countryCode, item.finalStatus]));
    const currentByCountry = new Map(current.map((item) => [item.countryCode, item.finalStatus]));

    let changed = 0;
    const allCodes = new Set([...previousByCountry.keys(), ...currentByCountry.keys()]);
    for (const code of allCodes) {
      if (previousByCountry.get(code) !== currentByCountry.get(code)) {
        changed += 1;
      }
    }
    return changed;
  }
}
