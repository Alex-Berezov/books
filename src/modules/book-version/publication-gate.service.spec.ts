import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

describe('PublicationGateService', () => {
  let service: PublicationGateService;
  let prisma: jest.Mocked<PrismaService>;
  let mockRightsContentHashService: jest.Mocked<RightsContentHashService>;

  const baseVersion = {
    id: 'v1',
    bookId: 'b1',
    rightsProfileId: 'profile-1',
    approvedRightsReviewId: 'review-1',
    rightsStatus: 'APPROVED',
    rightsContentHash: 'baseline-hash-123',
    rightsRecheckRequired: false,
    rightsBlockedCountryCodes: [],
    rightsLicenseRequiredCountryCodes: [],
    rightsPendingCountryCodes: [],
    rightsRequiredActions: [],
    rightsGeoBlockRequired: false,
    rightsGeoBlockConfigured: false,
    book: {
      id: 'b1',
      currentRightsProfileId: 'profile-1',
      approvedRightsReviewId: 'review-1',
    },
  };

  const baseReview = {
    id: 'review-1',
    status: 'HUMAN_APPROVED',
  };

  const baseProfile = {
    id: 'profile-1',
    status: 'APPROVED',
    isCurrent: true,
    publicationGate: 'ALLOW',
  };

  beforeEach(() => {
    prisma = {
      bookVersion: {
        findUnique: jest.fn(),
      },
      rightsReview: {
        findUnique: jest.fn(),
      },
      rightsProfile: {
        findUnique: jest.fn(),
      },
      rightsAction: {
        findMany: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;

    mockRightsContentHashService = {
      computeVersionHash: jest
        .fn()
        .mockResolvedValue({ hash: 'baseline-hash-123', algorithmVersion: '1.0' }),
      initializeVersionBaseline: jest.fn(),
      checkVersionStaleness: jest.fn(),
      markVersionAndClearanceStale: jest.fn(),
    } as unknown as jest.Mocked<RightsContentHashService>;

    service = new PublicationGateService(prisma, mockRightsContentHashService);
  });

  // 6.1 Version not found
  it('throws NotFoundException if version not found', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.checkVersionCanPublish('nonexistent')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // 6.2 Missing rightsProfileId
  it('blocks if rightsProfileId is missing', async () => {
    const version = { ...baseVersion, rightsProfileId: null };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'MISSING_RIGHTS_PROFILE')).toBe(true);
  });

  // 6.3 Missing approvedRightsReviewId
  it('blocks if approvedRightsReviewId is missing', async () => {
    const version = { ...baseVersion, approvedRightsReviewId: null };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'MISSING_APPROVED_RIGHTS_REVIEW')).toBe(
      true,
    );
  });

  // 6.4 Review not found
  it('blocks if approved review is not found', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'APPROVED_REVIEW_NOT_FOUND')).toBe(true);
  });

  // 6.5 Review not HUMAN_APPROVED
  it('blocks if review status is not HUMAN_APPROVED', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue({
      ...baseReview,
      status: 'HUMAN_REVIEW_REQUIRED',
    });
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_REVIEW_NOT_APPROVED')).toBe(true);
  });

  // 6.6 Review STALE
  it('blocks if review status is STALE', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue({
      ...baseReview,
      status: 'STALE',
    });
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_REVIEW_STALE')).toBe(true);
  });

  // 6.6 Review SUPERSEDED
  it('blocks if review status is SUPERSEDED', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue({
      ...baseReview,
      status: 'SUPERSEDED',
    });
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_REVIEW_SUPERSEDED')).toBe(true);
  });

  // 6.7 Profile not found
  it('blocks if profile is not found', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_PROFILE_NOT_FOUND')).toBe(true);
  });

  // 6.8 Profile not APPROVED
  it('blocks if profile status is not APPROVED', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue({
      ...baseProfile,
      status: 'IMPORTED',
    });
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_PROFILE_NOT_APPROVED')).toBe(true);
  });

  // 6.9 Profile STALE
  it('blocks if profile status is STALE', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue({
      ...baseProfile,
      status: 'STALE',
    });
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_PROFILE_STALE')).toBe(true);
  });

  // 6.9 Profile SUPERSEDED
  it('blocks if profile status is SUPERSEDED', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue({
      ...baseProfile,
      status: 'SUPERSEDED',
    });
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_PROFILE_SUPERSEDED')).toBe(true);
  });

  // 6.10 Profile not current
  it('blocks if profile is not current', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue({
      ...baseProfile,
      isCurrent: false,
    });
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_PROFILE_NOT_CURRENT')).toBe(true);
  });

  // 6.11 publicationGate BLOCK
  it('blocks if publicationGate is BLOCK', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue({
      ...baseProfile,
      publicationGate: 'BLOCK',
    });
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'PUBLICATION_GATE_BLOCK')).toBe(true);
  });

  // 6.12 Unresolved blocking action
  it('blocks if there is an unresolved blocking action', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([
      { id: 'action-1', status: 'PENDING', isBlocking: true },
    ]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'UNRESOLVED_BLOCKING_RIGHTS_ACTION')).toBe(
      true,
    );
  });

  // 6.12 Blocking action COMPLETED -> allowed
  it('allows if blocking action is COMPLETED', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    // findMany with status notIn: ['COMPLETED', 'WAIVED'] should return empty
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(true);
  });

  // 6.12 Blocking action WAIVED -> allowed
  it('allows if blocking action is WAIVED', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    // findMany with status notIn: ['COMPLETED', 'WAIVED'] should return empty
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(true);
  });

  // 6.13 Blocked countries + geo not configured
  it('blocks if blocked countries exist and geo not configured', async () => {
    const version = { ...baseVersion, rightsBlockedCountryCodes: ['RU'] };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(
      result.blockingReasons.some((r) => r.code === 'BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK'),
    ).toBe(true);
  });

  // 6.13 Blocked countries + geo configured -> allowed (warning)
  it('allows if blocked countries exist and geo is configured', async () => {
    const version = {
      ...baseVersion,
      rightsBlockedCountryCodes: ['RU'],
      rightsGeoBlockConfigured: true,
    };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(true);
    expect(result.warnings.some((r) => r.code === 'BLOCKED_COUNTRIES_WITH_GEO_BLOCK')).toBe(true);
  });

  // 6.14 License required countries
  it('blocks if license required countries exist', async () => {
    const version = { ...baseVersion, rightsLicenseRequiredCountryCodes: ['DE'] };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'LICENSE_REQUIRED')).toBe(true);
  });

  // 6.15 Pending countries
  it('blocks if pending countries exist', async () => {
    const version = { ...baseVersion, rightsPendingCountryCodes: ['FR'] };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'PENDING_TERRITORIES')).toBe(true);
  });

  // 6.16 Snapshot mismatch - profile
  it('blocks if version rightsProfileId differs from book currentRightsProfileId', async () => {
    const version = { ...baseVersion, rightsProfileId: 'old-profile' };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_PROFILE_SNAPSHOT_OUTDATED')).toBe(
      true,
    );
  });

  // 6.16 Snapshot mismatch - review
  it('blocks if version approvedRightsReviewId differs from book approvedRightsReviewId', async () => {
    const version = { ...baseVersion, approvedRightsReviewId: 'old-review' };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_REVIEW_SNAPSHOT_OUTDATED')).toBe(
      true,
    );
  });

  // 6.17 Geo-block required but not configured
  it('blocks if geoBlockRequired is true and not configured', async () => {
    const version = {
      ...baseVersion,
      rightsGeoBlockRequired: true,
      rightsGeoBlockConfigured: false,
    };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'GEO_BLOCK_NOT_CONFIGURED')).toBe(true);
  });

  it('blocks publishing when hash computation fails', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    mockRightsContentHashService.computeVersionHash.mockRejectedValue(
      new Error('DB connection failed'),
    );
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(false);
    expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_CONTENT_HASH_CHECK_FAILED')).toBe(
      true,
    );
  });

  // Fully valid version -> canPublish = true
  it('allows publishing for a fully valid version', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    const result = await service.checkVersionCanPublish('v1');
    expect(result.canPublish).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
  });

  // assertVersionCanPublish throws structured error if blocked
  it('assertVersionCanPublish throws BadRequestException if blocked', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
      ...baseVersion,
      rightsProfileId: null,
    });
    await expect(service.assertVersionCanPublish('v1')).rejects.toBeInstanceOf(BadRequestException);
    try {
      await service.assertVersionCanPublish('v1');
    } catch (e: any) {
      expect(e.response.code).toBe('RIGHTS_PUBLICATION_BLOCKED');
      expect(e.response.canPublish).toBe(false);
      expect(Array.isArray(e.response.blockingReasons)).toBe(true);
    }
  });

  // assertVersionCanPublish does not throw if allowed
  it('assertVersionCanPublish does not throw if allowed', async () => {
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    await expect(service.assertVersionCanPublish('v1')).resolves.toBeUndefined();
  });
});
