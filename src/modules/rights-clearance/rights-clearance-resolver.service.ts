import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  classifyTerritoryDecisions,
  toCountryCodeList,
  type ClearanceCountryLists,
} from './rights-clearance.util';

/** Where the returned market lists came from. */
export type ClearanceCountryListsSource = 'EFFECTIVE_PROFILE' | 'VERSION_SNAPSHOT';

/**
 * Both halves of a version's clearance at once: the write-once snapshot it was published under
 * and the clearance that applies right now.
 */
export interface EffectiveClearance extends ClearanceCountryLists {
  bookVersionId: string;
  bookId: string;
  rightsIntakeId: string | null;
  /** `BookVersion.rightsProfileId` — audit record of the publication, never rewritten. */
  snapshotProfileId: string | null;
  /** `BookVersion.approvedRightsReviewId` — same, for the review. */
  snapshotReviewId: string | null;
  /** Current profile of the book's intake; falls back to the snapshot when nothing newer exists. */
  effectiveProfileId: string | null;
  /** Currently approved review of the book's intake; same fallback. */
  effectiveReviewId: string | null;
  /** The version is published under a profile that is no longer the current one. */
  profileOutdated: boolean;
  /** The version is published under a review that is no longer the approved one. */
  reviewOutdated: boolean;
  countryListsSource: ClearanceCountryListsSource;
}

/**
 * WP-2: the one place that answers "what clearance applies to this version right now".
 *
 * `BookVersion.rightsProfileId`, `approvedRightsReviewId` and the four country lists are written
 * once, when the book is created from an approved intake, and never updated again — approving a
 * new review touches the intake and the profile only. Treating those columns as the current state
 * froze the clearance at creation time (R5-03, R8-01, R8-03, R9-01).
 *
 * The split this service implements: the columns stay as the audit record of what the version was
 * published under, and everything that needs the *current* clearance resolves it on read through
 * `Book.rightsIntakeId` → current `RightsProfile` / `RightsIntake.approvedReviewId`, the same way
 * Phases 15, 16, 18 and 19 already work.
 */
@Injectable()
export class RightsClearanceResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveForVersion(bookVersionId: string): Promise<EffectiveClearance> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: {
        id: true,
        bookId: true,
        rightsProfileId: true,
        approvedRightsReviewId: true,
        rightsAllowedCountryCodes: true,
        rightsBlockedCountryCodes: true,
        rightsLicenseRequiredCountryCodes: true,
        rightsPendingCountryCodes: true,
        book: {
          select: {
            id: true,
            rightsIntakeId: true,
            currentRightsProfileId: true,
            approvedRightsReviewId: true,
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const intakeId = version.book.rightsIntakeId;
    const { profileId: resolvedProfileId, reviewId: resolvedReviewId } = intakeId
      ? await this.resolveFromIntake(intakeId)
      : {
          // Books created before Phase 6 have no intake; the book-level columns are all we have.
          profileId: version.book.currentRightsProfileId,
          reviewId: version.book.approvedRightsReviewId,
        };

    const snapshotProfileId = version.rightsProfileId;
    const snapshotReviewId = version.approvedRightsReviewId;
    const effectiveProfileId = resolvedProfileId ?? snapshotProfileId;
    const effectiveReviewId = resolvedReviewId ?? snapshotReviewId;

    const { lists, countryListsSource } = await this.resolveCountryLists(
      effectiveProfileId,
      version,
    );

    return {
      bookVersionId: version.id,
      bookId: version.bookId,
      rightsIntakeId: intakeId,
      snapshotProfileId,
      snapshotReviewId,
      effectiveProfileId,
      effectiveReviewId,
      profileOutdated:
        resolvedProfileId !== null &&
        snapshotProfileId !== null &&
        resolvedProfileId !== snapshotProfileId,
      reviewOutdated:
        resolvedReviewId !== null &&
        snapshotReviewId !== null &&
        resolvedReviewId !== snapshotReviewId,
      countryListsSource,
      ...lists,
    };
  }

  /**
   * `RightsIntake.approvedReviewId` is the authoritative pointer: materialising a new report clears
   * it, approving a review of the current profile sets it. So it can never name a review of a
   * superseded profile.
   */
  private async resolveFromIntake(
    intakeId: string,
  ): Promise<{ profileId: string | null; reviewId: string | null }> {
    const [currentProfile, intake] = await Promise.all([
      this.prisma.rightsProfile.findFirst({
        where: { rightsIntakeId: intakeId, isCurrent: true },
        select: { id: true },
      }),
      this.prisma.rightsIntake.findUnique({
        where: { id: intakeId },
        select: { approvedReviewId: true },
      }),
    ]);

    return {
      profileId: currentProfile?.id ?? null,
      reviewId: intake?.approvedReviewId ?? null,
    };
  }

  /**
   * A profile without territory decisions cannot describe any market, so an empty result there is
   * not evidence that the markets are open — in that case the stored snapshot is kept.
   */
  private async resolveCountryLists(
    effectiveProfileId: string | null,
    version: {
      rightsAllowedCountryCodes: unknown;
      rightsBlockedCountryCodes: unknown;
      rightsLicenseRequiredCountryCodes: unknown;
      rightsPendingCountryCodes: unknown;
    },
  ): Promise<{ lists: ClearanceCountryLists; countryListsSource: ClearanceCountryListsSource }> {
    if (effectiveProfileId) {
      const decisions = await this.prisma.territoryDecision.findMany({
        where: { rightsProfileId: effectiveProfileId },
        select: { countryCode: true, accessPolicy: true, finalStatus: true },
      });

      if (decisions.length > 0) {
        return {
          lists: classifyTerritoryDecisions(decisions),
          countryListsSource: 'EFFECTIVE_PROFILE',
        };
      }
    }

    return {
      lists: {
        allowedCountryCodes: toCountryCodeList(version.rightsAllowedCountryCodes),
        blockedCountryCodes: toCountryCodeList(version.rightsBlockedCountryCodes),
        licenseRequiredCountryCodes: toCountryCodeList(version.rightsLicenseRequiredCountryCodes),
        pendingCountryCodes: toCountryCodeList(version.rightsPendingCountryCodes),
      },
      countryListsSource: 'VERSION_SNAPSHOT',
    };
  }
}
