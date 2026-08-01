import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClearanceResolverService } from './rights-clearance-resolver.service';

describe('RightsClearanceResolverService', () => {
  let prisma: {
    bookVersion: { findUnique: jest.Mock };
    rightsProfile: { findFirst: jest.Mock };
    rightsIntake: { findUnique: jest.Mock };
    territoryDecision: { findMany: jest.Mock };
  };
  let service: RightsClearanceResolverService;

  /** Version published under profile-1 / review-1, with the snapshot those produced. */
  const snapshotVersion = {
    id: 'v1',
    bookId: 'b1',
    rightsProfileId: 'profile-1',
    approvedRightsReviewId: 'review-1',
    rightsAllowedCountryCodes: ['US'],
    rightsBlockedCountryCodes: ['DE'],
    rightsLicenseRequiredCountryCodes: [],
    rightsPendingCountryCodes: [],
    book: {
      id: 'b1',
      rightsIntakeId: 'intake-1',
      currentRightsProfileId: 'profile-1',
      approvedRightsReviewId: 'review-1',
    },
  };

  beforeEach(() => {
    prisma = {
      bookVersion: { findUnique: jest.fn().mockResolvedValue(snapshotVersion) },
      rightsProfile: { findFirst: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
      rightsIntake: { findUnique: jest.fn().mockResolvedValue({ approvedReviewId: 'review-1' }) },
      territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new RightsClearanceResolverService(prisma as unknown as PrismaService);
  });

  it('throws when the version does not exist', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.resolveForVersion('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports no drift while the version sits on the current clearance', async () => {
    const clearance = await service.resolveForVersion('v1');

    expect(clearance.effectiveProfileId).toBe('profile-1');
    expect(clearance.effectiveReviewId).toBe('review-1');
    expect(clearance.profileOutdated).toBe(false);
    expect(clearance.reviewOutdated).toBe(false);
  });

  // WP-2.1 acceptance: a re-check materialises a new profile and the editor approves its review.
  it('returns the new clearance after a re-check, leaving the version snapshot untouched', async () => {
    prisma.rightsProfile.findFirst.mockResolvedValue({ id: 'profile-2' });
    prisma.rightsIntake.findUnique.mockResolvedValue({ approvedReviewId: 'review-2' });

    const clearance = await service.resolveForVersion('v1');

    expect(clearance.effectiveProfileId).toBe('profile-2');
    expect(clearance.effectiveReviewId).toBe('review-2');
    expect(clearance.profileOutdated).toBe(true);
    expect(clearance.reviewOutdated).toBe(true);
    // The audit record of the publication is read back unchanged.
    expect(clearance.snapshotProfileId).toBe('profile-1');
    expect(clearance.snapshotReviewId).toBe('review-1');
  });

  it('does not call a version outdated while the new report is still awaiting approval', async () => {
    prisma.rightsProfile.findFirst.mockResolvedValue({ id: 'profile-2' });
    // Materialisation clears `approvedReviewId`; nothing newer is approved yet.
    prisma.rightsIntake.findUnique.mockResolvedValue({ approvedReviewId: null });

    const clearance = await service.resolveForVersion('v1');

    expect(clearance.reviewOutdated).toBe(false);
    expect(clearance.effectiveReviewId).toBe('review-1');
    expect(clearance.profileOutdated).toBe(true);
  });

  it('recomputes the market lists from the effective profile', async () => {
    prisma.rightsProfile.findFirst.mockResolvedValue({ id: 'profile-2' });
    prisma.territoryDecision.findMany.mockResolvedValue([
      { countryCode: 'US', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED' },
      { countryCode: 'DE', accessPolicy: 'BLOCK', finalStatus: 'BLOCKED' },
      { countryCode: 'FR', accessPolicy: 'BLOCK', finalStatus: 'BLOCKED' },
      { countryCode: 'GB', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'PENDING_REVIEW' },
      { countryCode: 'ES', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'LICENSE_REQUIRED' },
    ]);

    const clearance = await service.resolveForVersion('v1');

    expect(prisma.territoryDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { rightsProfileId: 'profile-2' } }),
    );
    expect(clearance.countryListsSource).toBe('EFFECTIVE_PROFILE');
    expect(clearance.allowedCountryCodes).toEqual(['US']);
    // FR was not in the version snapshot — the new clearance closed that market.
    expect(clearance.blockedCountryCodes).toEqual(['DE', 'FR']);
    expect(clearance.pendingCountryCodes).toEqual(['GB']);
    expect(clearance.licenseRequiredCountryCodes).toEqual(['ES']);
  });

  it('keeps the version snapshot when the effective profile has no territory decisions', async () => {
    const clearance = await service.resolveForVersion('v1');

    expect(clearance.countryListsSource).toBe('VERSION_SNAPSHOT');
    expect(clearance.blockedCountryCodes).toEqual(['DE']);
    expect(clearance.allowedCountryCodes).toEqual(['US']);
  });

  it('falls back to the book columns for a book with no rights intake', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({
      ...snapshotVersion,
      book: {
        id: 'b1',
        rightsIntakeId: null,
        currentRightsProfileId: 'profile-9',
        approvedRightsReviewId: 'review-9',
      },
    });

    const clearance = await service.resolveForVersion('v1');

    expect(prisma.rightsIntake.findUnique).not.toHaveBeenCalled();
    expect(clearance.effectiveProfileId).toBe('profile-9');
    expect(clearance.effectiveReviewId).toBe('review-9');
    expect(clearance.profileOutdated).toBe(true);
    expect(clearance.reviewOutdated).toBe(true);
  });
});
