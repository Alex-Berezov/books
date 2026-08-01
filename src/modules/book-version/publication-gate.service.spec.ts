import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { ClaimGateEvaluationDto } from '../rights-claims/dto/rights-claim-response.dto';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import type { EffectiveClearance } from '../rights-clearance/rights-clearance-resolver.service';
import { RightsRecheckService } from '../rights-recheck/rights-recheck.service';
import { RightsLawyerReviewService } from '../rights-lawyer/rights-lawyer-review.service';
import { RecheckGateEvaluationDto } from '../rights-recheck/dto/version-recheck-response.dto';
import { LawyerGateEvaluationDto } from '../rights-lawyer/dto/version-lawyer-review-response.dto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Default coverage result: no market needs a license, so no license reason is produced. */
const notRequiredCoverage = () => ({
  status: 'NOT_REQUIRED' as const,
  checkedAt: '2026-07-28T00:00:00.000Z',
  requiredCountryCodes: [],
  coveredCountryCodes: [],
  uncoveredCountryCodes: [],
  countries: [],
  licenseIds: [],
  blockers: [],
  warnings: [],
  attributionTextsRu: [],
});

/** Default claim evaluation: the version has no claims at all. */
const noClaims = (overrides: Partial<ClaimGateEvaluationDto> = {}): ClaimGateEvaluationDto => ({
  activeClaimsCount: 0,
  blockingClaimsCount: 0,
  criticalClaimsCount: 0,
  overdueClaimsCount: 0,
  activeBlocksCount: 0,
  hasWorldwideBlock: false,
  claimBlockedCountryCodes: [],
  worstSeverity: null,
  claimIds: [],
  blockers: [],
  warnings: [],
  ...overrides,
});

/** Default recheck evaluation (Phase 18): no open recheck task for the version. */
const noRecheck = (
  overrides: Partial<RecheckGateEvaluationDto> = {},
): RecheckGateEvaluationDto => ({
  versionId: 'v1',
  blockers: [],
  warnings: [],
  openTasksCount: 0,
  overdueTasksCount: 0,
  blockingTasksCount: 0,
  nextRecheckDueAt: null,
  taskIds: [],
  ...overrides,
});

/** Default lawyer evaluation (Phase 19): no legal review touches the version. */
const noLawyerReview = (
  overrides: Partial<LawyerGateEvaluationDto> = {},
): LawyerGateEvaluationDto => ({
  versionId: 'v1',
  blockers: [],
  warnings: [],
  lawyerReviewRequired: false,
  lawyerApproved: false,
  openReviewsCount: 0,
  pendingConditionsCount: 0,
  riskLevel: null,
  lawyerOpinionValidUntil: null,
  reviewIds: [],
  ...overrides,
});

/** One row of `BookVersion` as the gate spec mocks it. */
type MockVersion = Record<string, unknown> & {
  book: {
    id: string;
    currentRightsProfileId: string | null;
    approvedRightsReviewId: string | null;
  };
};

const asCodes = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

/**
 * What the real resolver returns for a version whose clearance never moved: the effective ids come
 * from the book columns and the market lists from the version snapshot. Tests that need a version
 * left behind by a newer clearance override the fields they care about.
 */
const snapshotClearance = (version: MockVersion): EffectiveClearance => {
  const snapshotProfileId = (version.rightsProfileId as string | null) ?? null;
  const snapshotReviewId = (version.approvedRightsReviewId as string | null) ?? null;
  const effectiveProfileId = version.book.currentRightsProfileId ?? snapshotProfileId;
  const effectiveReviewId = version.book.approvedRightsReviewId ?? snapshotReviewId;

  return {
    bookVersionId: version.id as string,
    bookId: version.bookId as string,
    rightsIntakeId: 'intake-1',
    snapshotProfileId,
    snapshotReviewId,
    effectiveProfileId,
    effectiveReviewId,
    profileOutdated: snapshotProfileId !== null && effectiveProfileId !== snapshotProfileId,
    reviewOutdated: snapshotReviewId !== null && effectiveReviewId !== snapshotReviewId,
    countryListsSource: 'VERSION_SNAPSHOT',
    allowedCountryCodes: asCodes(version.rightsAllowedCountryCodes),
    blockedCountryCodes: asCodes(version.rightsBlockedCountryCodes),
    licenseRequiredCountryCodes: asCodes(version.rightsLicenseRequiredCountryCodes),
    pendingCountryCodes: asCodes(version.rightsPendingCountryCodes),
  };
};

describe('PublicationGateService', () => {
  let service: PublicationGateService;
  let prisma: jest.Mocked<PrismaService>;
  let mockRightsContentHashService: jest.Mocked<RightsContentHashService>;
  let mockGeoBlockRuleService: jest.Mocked<GeoBlockRuleService>;
  let mockLicenseCoverageService: { evaluateVersionCoverage: jest.Mock };
  let mockRightsClaimsService: { evaluateVersionClaims: jest.Mock };
  let mockRightsRecheckService: { evaluateVersionRecheck: jest.Mock };
  let mockRightsLawyerReviewService: { evaluateVersionLawyerReview: jest.Mock };
  let mockClearanceResolver: { resolveForVersion: jest.Mock };

  /** Makes the resolver answer with a clearance built on top of the currently mocked version. */
  const arrangeClearance = (overrides: Partial<EffectiveClearance> = {}) => {
    mockClearanceResolver.resolveForVersion.mockImplementation(async () => {
      const version = (await (prisma.bookVersion.findUnique as jest.Mock)(
        {},
      )) as MockVersion | null;
      return { ...snapshotClearance(version ?? (baseVersion as MockVersion)), ...overrides };
    });
  };

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
    rightsGeoBlockVerifiedAt: null,
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

    mockGeoBlockRuleService = {
      getActiveRulesForVersion: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<GeoBlockRuleService>;

    mockLicenseCoverageService = {
      evaluateVersionCoverage: jest.fn().mockResolvedValue(notRequiredCoverage()),
    };

    mockRightsClaimsService = {
      evaluateVersionClaims: jest.fn().mockResolvedValue(noClaims()),
    };

    mockRightsRecheckService = {
      evaluateVersionRecheck: jest.fn().mockResolvedValue(noRecheck()),
    };

    mockRightsLawyerReviewService = {
      evaluateVersionLawyerReview: jest.fn().mockResolvedValue(noLawyerReview()),
    };

    mockClearanceResolver = { resolveForVersion: jest.fn() };
    arrangeClearance();

    service = new PublicationGateService(
      prisma,
      mockRightsContentHashService,
      mockGeoBlockRuleService,
      mockLicenseCoverageService as unknown as RightsLicenseCoverageService,
      mockRightsClaimsService as unknown as RightsClaimsService,
      mockRightsRecheckService as unknown as RightsRecheckService,
      mockRightsLawyerReviewService as unknown as RightsLawyerReviewService,
      mockClearanceResolver as unknown as RightsClearanceResolverService,
    );
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

  // 6.14 License coverage (Phase 15)
  describe('license coverage', () => {
    const arrangeVersion = (overrides: Record<string, unknown> = {}) => {
      const version = { ...baseVersion, rightsLicenseRequiredCountryCodes: ['DE'], ...overrides };
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    };

    const blockerCoverage = (code: string, messageRu: string) => ({
      ...notRequiredCoverage(),
      status: 'NOT_COVERED' as const,
      requiredCountryCodes: ['DE'],
      uncoveredCountryCodes: ['DE'],
      blockers: [{ code, severity: 'BLOCKER' as const, messageRu, countryCode: 'DE' }],
    });

    it('does not block when a valid license covers the required countries', async () => {
      arrangeVersion();
      mockLicenseCoverageService.evaluateVersionCoverage.mockResolvedValue({
        ...notRequiredCoverage(),
        status: 'COVERED',
        requiredCountryCodes: ['DE'],
        coveredCountryCodes: ['DE'],
        licenseIds: ['lic-1'],
      });

      const result = await service.checkVersionCanPublish('v1');

      expect(result.blockingReasons.some((r) => r.code.startsWith('LICENSE_'))).toBe(false);
      expect(result.licenseCoverageStatus).toBe('COVERED');
      expect(result.licenseCoveredCountryCodes).toEqual(['DE']);
      expect(result.licenseIds).toEqual(['lic-1']);
    });

    it.each([
      ['LICENSE_MISSING_FOR_COUNTRY', 'Нет лицензии для страны DE.'],
      ['LICENSE_EXPIRED', 'Срок действия лицензии истёк.'],
      ['LICENSE_REVOKED', 'Лицензия отозвана.'],
      ['LICENSE_SCOPE_LANGUAGE_MISMATCH', 'Лицензия не покрывает язык версии.'],
    ])('blocks with %s', async (code, messageRu) => {
      arrangeVersion();
      mockLicenseCoverageService.evaluateVersionCoverage.mockResolvedValue(
        blockerCoverage(code, messageRu),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      expect(result.blockingReasons.some((r) => r.code === code)).toBe(true);
      expect(result.licenseUncoveredCountryCodes).toEqual(['DE']);
    });

    it('warns about attribution when the version has no attribution text yet', async () => {
      arrangeVersion();
      mockLicenseCoverageService.evaluateVersionCoverage.mockResolvedValue({
        ...notRequiredCoverage(),
        status: 'COVERED',
        requiredCountryCodes: ['DE'],
        coveredCountryCodes: ['DE'],
        licenseIds: ['lic-1'],
        warnings: [
          {
            code: 'LICENSE_ATTRIBUTION_REQUIRED',
            severity: 'WARNING' as const,
            messageRu: 'Лицензия требует указания правообладателя.',
            licenseId: 'lic-1',
          },
        ],
        attributionTextsRu: ['© Penguin Random House, 2019'],
      });

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.warnings.some((r) => r.code === 'LICENSE_ATTRIBUTION_REQUIRED')).toBe(true);
    });

    it('never returns the removed LICENSE_REQUIRED code', async () => {
      arrangeVersion();
      mockLicenseCoverageService.evaluateVersionCoverage.mockResolvedValue(
        blockerCoverage('LICENSE_MISSING_FOR_COUNTRY', 'Нет лицензии для страны DE.'),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.blockingReasons.some((r) => r.code === 'LICENSE_REQUIRED')).toBe(false);
      expect(result.warnings.some((r) => r.code === 'LICENSE_REQUIRED')).toBe(false);
    });
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

  // WP-2.2: approving a new review updates the intake, not the book — the two snapshot codes have
  // to be driven by the resolved clearance, otherwise they can never fire (R5-03, R10-02).
  describe('6.16 snapshot mismatch against the clearance in force', () => {
    const arrangeUnchangedBookColumns = () => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    };

    it('blocks when a newer review was approved for the intake', async () => {
      arrangeUnchangedBookColumns();
      arrangeClearance({ effectiveReviewId: 'review-2', reviewOutdated: true });

      const result = await service.checkVersionCanPublish('v1');
      const reason = result.blockingReasons.find(
        (item) => item.code === 'RIGHTS_REVIEW_SNAPSHOT_OUTDATED',
      );

      expect(result.canPublish).toBe(false);
      expect(reason?.details).toEqual({
        versionReviewId: 'review-1',
        effectiveReviewId: 'review-2',
      });
    });

    it('blocks when a newer profile was materialised for the intake', async () => {
      arrangeUnchangedBookColumns();
      arrangeClearance({ effectiveProfileId: 'profile-2', profileOutdated: true });

      const result = await service.checkVersionCanPublish('v1');
      const reason = result.blockingReasons.find(
        (item) => item.code === 'RIGHTS_PROFILE_SNAPSHOT_OUTDATED',
      );

      expect(result.canPublish).toBe(false);
      expect(reason?.details).toEqual({
        versionProfileId: 'profile-1',
        effectiveProfileId: 'profile-2',
      });
    });

    it('does not block while the version still sits on the clearance in force', async () => {
      arrangeUnchangedBookColumns();

      const result = await service.checkVersionCanPublish('v1');

      expect(result.blockingReasons.some((r) => r.code.endsWith('_SNAPSHOT_OUTDATED'))).toBe(false);
    });
  });

  // WP-2.4: the four country lists on BookVersion are write-once too (R8-01, R8-03).
  describe('market lists come from the clearance in force', () => {
    const arrangeVersion = (overrides: Record<string, unknown> = {}) => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
        ...baseVersion,
        ...overrides,
      });
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    };

    it('requires geo-block for a country the new review blocked', async () => {
      arrangeVersion();
      arrangeClearance({ blockedCountryCodes: ['RU'], countryListsSource: 'EFFECTIVE_PROFILE' });

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      expect(
        result.blockingReasons.some((r) => r.code === 'BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK'),
      ).toBe(true);
    });

    it('requires a runtime rule for a country the new review blocked', async () => {
      arrangeVersion({
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
        rightsGeoBlockVerifiedAt: new Date(),
      });
      arrangeClearance({
        blockedCountryCodes: ['GB', 'DE'],
        countryListsSource: 'EFFECTIVE_PROFILE',
      });
      mockGeoBlockRuleService.getActiveRulesForVersion.mockResolvedValue([
        {
          id: 'rule-1',
          countryCode: 'GB',
          scope: GeoBlockScope.LANGUAGE_EDITION,
          verifiedAt: new Date(),
        },
      ] as never);

      const result = await service.checkVersionCanPublish('v1');
      const reason = result.blockingReasons.find((item) => item.code === 'GEO_BLOCK_RULES_MISSING');

      expect(reason?.details).toEqual({ missingCountryCodes: ['DE'] });
    });

    it('blocks on a territory the new review left pending', async () => {
      arrangeVersion();
      arrangeClearance({ pendingCountryCodes: ['FR'], countryListsSource: 'EFFECTIVE_PROFILE' });

      const result = await service.checkVersionCanPublish('v1');

      expect(result.blockingReasons.some((r) => r.code === 'PENDING_TERRITORIES')).toBe(true);
    });

    it('stops requiring geo-block once the new review reopened the market', async () => {
      arrangeVersion({ rightsBlockedCountryCodes: ['RU'] });
      arrangeClearance({ blockedCountryCodes: [], countryListsSource: 'EFFECTIVE_PROFILE' });

      const result = await service.checkVersionCanPublish('v1');

      expect(
        result.blockingReasons.some((r) => r.code === 'BLOCKED_COUNTRIES_REQUIRE_GEO_BLOCK'),
      ).toBe(false);
    });
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

  it('blocks if geo-block rules are missing', async () => {
    const version = {
      ...baseVersion,
      rightsGeoBlockRequired: true,
      rightsGeoBlockConfigured: true,
      rightsGeoBlockVerifiedAt: new Date(),
    };
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkVersionCanPublish('v1');

    expect(result.blockingReasons.some((r) => r.code === 'GEO_BLOCK_RULES_MISSING')).toBe(true);
  });

  it('blocks if generated rules do not cover every blocked country', async () => {
    const version = {
      ...baseVersion,
      rightsBlockedCountryCodes: ['GB', 'DE'],
      rightsGeoBlockRequired: true,
      rightsGeoBlockConfigured: true,
      rightsGeoBlockVerifiedAt: new Date(),
    };
    mockGeoBlockRuleService.getActiveRulesForVersion.mockResolvedValue([
      {
        id: 'rule-1',
        countryCode: 'GB',
        scope: GeoBlockScope.LANGUAGE_EDITION,
        verifiedAt: new Date(),
      },
    ] as never);
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkVersionCanPublish('v1');
    const reason = result.blockingReasons.find((item) => item.code === 'GEO_BLOCK_RULES_MISSING');

    expect(reason?.details).toEqual({ missingCountryCodes: ['DE'] });
  });

  it('blocks if active geo-block rules are not verified', async () => {
    const version = {
      ...baseVersion,
      rightsGeoBlockRequired: true,
      rightsGeoBlockConfigured: true,
      rightsGeoBlockVerifiedAt: new Date(),
    };
    mockGeoBlockRuleService.getActiveRulesForVersion.mockResolvedValue([
      { id: 'rule-1', countryCode: 'GB', scope: GeoBlockScope.LANGUAGE_EDITION, verifiedAt: null },
    ] as never);
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkVersionCanPublish('v1');

    expect(result.blockingReasons.some((r) => r.code === 'GEO_BLOCK_RULES_NOT_VERIFIED')).toBe(
      true,
    );
  });

  it('allows verified geo-block rules when all other checks pass', async () => {
    const verifiedAt = new Date();
    const version = {
      ...baseVersion,
      rightsGeoBlockRequired: true,
      rightsGeoBlockConfigured: true,
      rightsGeoBlockVerifiedAt: verifiedAt,
    };
    mockGeoBlockRuleService.getActiveRulesForVersion.mockResolvedValue([
      { id: 'rule-1', countryCode: 'GB', scope: GeoBlockScope.LANGUAGE_EDITION, verifiedAt },
    ] as never);
    (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(version);
    (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
    (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
    (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkVersionCanPublish('v1');

    expect(result.canPublish).toBe(true);
  });

  // WP-3.1: "the country is closed" and "the rule closes the country" are two different statements.
  // Counting rules by country accepted a TEXT_READER rule as coverage for a fully blocked market,
  // so the audio edition of the same text stayed reachable from it (R5-02, R6-01).
  describe('rule scope matches the verdict for the country', () => {
    const arrangeBlockedCountry = (blockedCountryCodes: string[] = ['GB']) => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue({
        ...baseVersion,
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
        rightsGeoBlockVerifiedAt: new Date(),
      });
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
      arrangeClearance({ blockedCountryCodes, countryListsSource: 'EFFECTIVE_PROFILE' });
    };

    const arrangeRules = (rules: Array<{ countryCode: string; scope: GeoBlockScope }>) => {
      mockGeoBlockRuleService.getActiveRulesForVersion.mockResolvedValue(
        rules.map((rule, index) => ({
          id: `rule-${index + 1}`,
          countryCode: rule.countryCode,
          scope: rule.scope,
          verifiedAt: new Date(),
        })) as never,
      );
    };

    it('blocks when a fully blocked country is covered only by a text rule', async () => {
      arrangeBlockedCountry();
      arrangeRules([{ countryCode: 'GB', scope: GeoBlockScope.TEXT_READER }]);

      const result = await service.checkVersionCanPublish('v1');
      const reason = result.blockingReasons.find(
        (item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT',
      );

      expect(result.canPublish).toBe(false);
      expect(reason?.details).toEqual({
        countryCodes: ['GB'],
        scopesByCountry: { GB: ['TEXT_READER'] },
        requiredScopes: [GeoBlockScope.ENTIRE_BOOK, GeoBlockScope.LANGUAGE_EDITION],
      });
    });

    it('blocks when a fully blocked country is covered only by a downloads rule', async () => {
      arrangeBlockedCountry();
      arrangeRules([{ countryCode: 'GB', scope: GeoBlockScope.DOWNLOADS }]);

      const result = await service.checkVersionCanPublish('v1');

      expect(
        result.blockingReasons.some((item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT'),
      ).toBe(true);
    });

    it('accepts a LANGUAGE_EDITION rule as coverage of a fully blocked country', async () => {
      arrangeBlockedCountry();
      arrangeRules([{ countryCode: 'GB', scope: GeoBlockScope.LANGUAGE_EDITION }]);

      const result = await service.checkVersionCanPublish('v1');

      expect(
        result.blockingReasons.some((item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT'),
      ).toBe(false);
      expect(result.canPublish).toBe(true);
    });

    it('accepts an ENTIRE_BOOK rule as coverage of a fully blocked country', async () => {
      arrangeBlockedCountry();
      arrangeRules([{ countryCode: 'GB', scope: GeoBlockScope.ENTIRE_BOOK }]);

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
    });

    it('leaves a partial-scope rule alone when the country is not blocked outright', async () => {
      arrangeBlockedCountry([]);
      arrangeRules([{ countryCode: 'DE', scope: GeoBlockScope.AUDIO }]);

      const result = await service.checkVersionCanPublish('v1');

      expect(
        result.blockingReasons.some((item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT'),
      ).toBe(false);
    });

    it('reports a country with no rule at all as missing, not as insufficient scope', async () => {
      arrangeBlockedCountry(['GB', 'DE']);
      arrangeRules([{ countryCode: 'GB', scope: GeoBlockScope.LANGUAGE_EDITION }]);

      const result = await service.checkVersionCanPublish('v1');

      expect(
        result.blockingReasons.find((item) => item.code === 'GEO_BLOCK_RULES_MISSING')?.details,
      ).toEqual({ missingCountryCodes: ['DE'] });
      expect(
        result.blockingReasons.some((item) => item.code === 'GEO_BLOCK_SCOPE_INSUFFICIENT'),
      ).toBe(false);
    });
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

  // ---------------------------------------------------------------------------
  // 6.18 Rights claims (Phase 16)
  // ---------------------------------------------------------------------------

  describe('rights claims', () => {
    beforeEach(() => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('blocks publication when an active blocking claim exists', async () => {
      mockRightsClaimsService.evaluateVersionClaims.mockResolvedValue(
        noClaims({
          activeClaimsCount: 1,
          blockingClaimsCount: 1,
          claimIds: ['claim-1'],
          blockers: [
            {
              code: 'ACTIVE_RIGHTS_CLAIM',
              severity: 'BLOCKER',
              messageRu: 'Публикация заблокирована активной претензией CLM-2026-000001.',
              claimId: 'claim-1',
              claimNumber: 'CLM-2026-000001',
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      expect(result.blockingReasons.some((r) => r.code === 'ACTIVE_RIGHTS_CLAIM')).toBe(true);
      expect(result.blockingClaimsCount).toBe(1);
      expect(result.claimIds).toEqual(['claim-1']);
    });

    it('only warns for an open claim that does not block publication', async () => {
      mockRightsClaimsService.evaluateVersionClaims.mockResolvedValue(
        noClaims({
          activeClaimsCount: 1,
          warnings: [
            {
              code: 'RIGHTS_CLAIM_OPEN_NON_BLOCKING',
              severity: 'WARNING',
              messageRu: 'Открытая претензия CLM-2026-000002 не блокирует публикацию.',
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.warnings.some((r) => r.code === 'RIGHTS_CLAIM_OPEN_NON_BLOCKING')).toBe(true);
    });

    it('blocks on an unresolved critical claim', async () => {
      mockRightsClaimsService.evaluateVersionClaims.mockResolvedValue(
        noClaims({
          criticalClaimsCount: 1,
          worstSeverity: 'CRITICAL' as ClaimGateEvaluationDto['worstSeverity'],
          blockers: [
            {
              code: 'CRITICAL_RIGHTS_CLAIM_UNRESOLVED',
              severity: 'BLOCKER',
              messageRu: 'Есть нерешённая критичная претензия CLM-2026-000003.',
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      expect(
        result.blockingReasons.some((r) => r.code === 'CRITICAL_RIGHTS_CLAIM_UNRESOLVED'),
      ).toBe(true);
      expect(result.worstClaimSeverity).toBe('CRITICAL');
    });

    it('blocks when a claim deadline is overdue', async () => {
      mockRightsClaimsService.evaluateVersionClaims.mockResolvedValue(
        noClaims({
          overdueClaimsCount: 1,
          blockers: [
            {
              code: 'RIGHTS_CLAIM_DEADLINE_OVERDUE',
              severity: 'BLOCKER',
              messageRu: 'Просрочен срок ответа по претензии CLM-2026-000004.',
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_CLAIM_DEADLINE_OVERDUE')).toBe(
        true,
      );
      expect(result.overdueClaimsCount).toBe(1);
    });

    it('warns but does not block when a claim deadline is approaching', async () => {
      mockRightsClaimsService.evaluateVersionClaims.mockResolvedValue(
        noClaims({
          activeClaimsCount: 1,
          warnings: [
            {
              code: 'RIGHTS_CLAIM_DEADLINE_SOON',
              severity: 'WARNING',
              messageRu: 'Срок ответа по претензии CLM-2026-000005 истекает через 3 дн.',
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.warnings.some((r) => r.code === 'RIGHTS_CLAIM_DEADLINE_SOON')).toBe(true);
    });

    it('does not block when every claim is resolved', async () => {
      mockRightsClaimsService.evaluateVersionClaims.mockResolvedValue(
        noClaims({ claimIds: ['claim-9'] }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.activeClaimsCount).toBe(0);
      expect(result.blockingReasons).toHaveLength(0);
    });
  });

  // 6.19 Automatic recheck (Phase 18)
  describe('6.19 Automatic recheck', () => {
    beforeEach(() => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('turns a recheck blocker into a blocking reason', async () => {
      mockRightsRecheckService.evaluateVersionRecheck.mockResolvedValue(
        noRecheck({
          openTasksCount: 1,
          overdueTasksCount: 1,
          blockingTasksCount: 1,
          taskIds: ['task-1'],
          blockers: [
            {
              code: 'RIGHTS_RECHECK_OVERDUE',
              messageRu: 'Перепроверка прав просрочена.',
              taskId: 'task-1',
              details: null,
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      expect(result.blockingReasons.some((r) => r.code === 'RIGHTS_RECHECK_OVERDUE')).toBe(true);
      expect(result.blockingRecheckTasksCount).toBe(1);
      expect(result.recheckTaskIds).toEqual(['task-1']);
    });

    it('turns a recheck warning into a warning without blocking', async () => {
      mockRightsRecheckService.evaluateVersionRecheck.mockResolvedValue(
        noRecheck({
          openTasksCount: 1,
          taskIds: ['task-2'],
          nextRecheckDueAt: '2026-09-01T00:00:00.000Z',
          warnings: [
            {
              code: 'RIGHTS_RECHECK_TASK_OPEN',
              messageRu: 'Открыта задача перепроверки прав.',
              taskId: 'task-2',
              details: null,
            },
          ],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.warnings.some((r) => r.code === 'RIGHTS_RECHECK_TASK_OPEN')).toBe(true);
      expect(result.nextRecheckDueAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('leaves the existing gate codes untouched when there is no recheck task', async () => {
      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.warnings.some((r) => r.code.startsWith('RIGHTS_RECHECK_'))).toBe(false);
      expect(result.openRecheckTasksCount).toBe(0);
      expect(result.rightsRecheckRequired).toBe(false);
    });
  });

  // 6.20 Lawyer workflow (Phase 19)
  describe('6.20 Lawyer workflow', () => {
    beforeEach(() => {
      (prisma.bookVersion.findUnique as jest.Mock).mockResolvedValue(baseVersion);
      (prisma.rightsReview.findUnique as jest.Mock).mockResolvedValue(baseReview);
      (prisma.rightsProfile.findUnique as jest.Mock).mockResolvedValue(baseProfile);
      (prisma.rightsAction.findMany as jest.Mock).mockResolvedValue([]);
    });

    const blocker = (code: string, lawyerReviewId: string | null = 'lr-1') => ({
      code,
      messageRu: `Блокер ${code}.`,
      lawyerReviewId,
      details: null,
    });

    it.each([
      'LAWYER_REVIEW_REQUIRED_NOT_APPROVED',
      'LAWYER_REVIEW_PENDING',
      'LAWYER_REVIEW_REJECTED',
      'LAWYER_OPINION_EXPIRED',
      'LAWYER_CONDITIONS_UNMET',
    ])('turns the %s blocker into a blocking reason', async (code) => {
      mockRightsLawyerReviewService.evaluateVersionLawyerReview.mockResolvedValue(
        noLawyerReview({
          lawyerReviewRequired: true,
          riskLevel: 'HIGH' as never,
          reviewIds: ['lr-1'],
          blockers: [blocker(code)],
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(false);
      const reason = result.blockingReasons.find((item) => item.code === code);
      expect(reason).toBeDefined();
      expect(reason?.details).toMatchObject({ lawyerReviewId: 'lr-1' });
      expect(result.lawyerReviewRequired).toBe(true);
      expect(result.riskLevel).toBe('HIGH');
      expect(result.lawyerReviewIds).toEqual(['lr-1']);
    });

    it.each([
      'LAWYER_REVIEW_OPEN_NON_BLOCKING',
      'LAWYER_OPINION_EXPIRING_SOON',
      'LAWYER_APPROVED_WITH_CONDITIONS',
      'HIGH_RISK_WITHOUT_LAWYER_REVIEW',
      'LAWYER_REVIEW_OVERDUE',
    ])('turns the %s warning into a warning without blocking', async (code) => {
      mockRightsLawyerReviewService.evaluateVersionLawyerReview.mockResolvedValue(
        noLawyerReview({ warnings: [blocker(code)] }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.warnings.some((item) => item.code === code)).toBe(true);
    });

    it('reports the lawyer metrics of an approved profile', async () => {
      mockRightsLawyerReviewService.evaluateVersionLawyerReview.mockResolvedValue(
        noLawyerReview({
          lawyerReviewRequired: true,
          lawyerApproved: true,
          openReviewsCount: 0,
          pendingConditionsCount: 2,
          lawyerOpinionValidUntil: '2030-01-01T00:00:00.000Z',
        }),
      );

      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.lawyerApproved).toBe(true);
      expect(result.pendingLawyerConditionsCount).toBe(2);
      expect(result.lawyerOpinionValidUntil).toBe('2030-01-01T00:00:00.000Z');
    });

    it('leaves the existing gate codes untouched when there is no legal review', async () => {
      const result = await service.checkVersionCanPublish('v1');

      expect(result.canPublish).toBe(true);
      expect(result.blockingReasons.some((item) => item.code.startsWith('LAWYER_'))).toBe(false);
      expect(result.warnings.some((item) => item.code.startsWith('LAWYER_'))).toBe(false);
      expect(result.lawyerReviewRequired).toBe(false);
      expect(result.lawyerApproved).toBe(false);
      expect(result.openLawyerReviewsCount).toBe(0);
      expect(result.riskLevel).toBeNull();
    });
  });
});
