import { RightsProfileService } from './rights-profile.service';
import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { RightsLicensesService } from '../rights-licenses/rights-licenses.service';
import { NotFoundException } from '@nestjs/common';

interface PrismaStub {
  rightsIntake: { findUnique: jest.Mock };
  $transaction: jest.Mock;
  [key: string]: unknown;
}

const createPrismaStub = (): PrismaStub => {
  const stub: Record<string, unknown> = {
    rightsIntake: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  stub['rightsProfile'] = { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() };
  stub['sourceEdition'] = { findUnique: jest.fn() };
  stub['editionRights'] = { findUnique: jest.fn() };
  stub['rightsReview'] = { findMany: jest.fn() };
  stub['rightsComponent'] = { findMany: jest.fn() };
  stub['territoryDecision'] = { findMany: jest.fn() };
  stub['rightsEvidence'] = { findMany: jest.fn() };
  stub['rightsAction'] = { findMany: jest.fn() };
  stub['rightsProfileContributor'] = { findMany: jest.fn().mockResolvedValue([]) };
  stub['rightsLicense'] = { findMany: jest.fn().mockResolvedValue([]) };
  stub['rightsLicenseLink'] = { findMany: jest.fn().mockResolvedValue([]) };
  stub['bookVersion'] = { findUnique: jest.fn().mockResolvedValue(null) };

  return stub as unknown as PrismaStub;
};

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  rightsIntakeId: 'intake-1',
  currentReviewImportId: 'import-1',
  status: 'IMPORTED',
  isCurrent: true,
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  summaryRu: 'test summary',
  conclusionRu: 'test conclusion',
  reasoningRu: 'test reasoning',
  nextReviewAt: new Date('2027-01-01T00:00:00.000Z'),
  supersededAt: null,
  archivedAt: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  ...overrides,
});

describe('RightsProfileService', () => {
  let service: RightsProfileService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    const coverageService = new RightsLicenseCoverageService(
      prisma as unknown as PrismaService,
      new RightsClearanceResolverService(prisma as unknown as PrismaService),
    );
    service = new RightsProfileService(
      prisma as unknown as PrismaService,
      new TerritoryRegionAggregationService(),
      new RightsLicensesService(prisma as unknown as PrismaService, coverageService),
      coverageService,
    );
  });

  describe('getCurrentByIntake', () => {
    it('should return current profile by intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'intake-1',
        workflowStatus: 'REVIEW_IMPORTED',
      });
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findFirst.mockResolvedValue(profile);
      const sourceEdition = null;
      (prisma['sourceEdition'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        sourceEdition,
      );
      (prisma['rightsReview'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsEvidence'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.getCurrentByIntake('intake-1');

      expect(result).toBeDefined();
      expect(result.id).toBe('profile-1');
      expect(result.rightsIntakeId).toBe('intake-1');
      expect(result.isCurrent).toBe(true);
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).findFirst).toHaveBeenCalledWith(
        {
          where: { rightsIntakeId: 'intake-1', isCurrent: true },
        },
      );
    });

    it('should throw NotFoundException when intake not found', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);

      await expect(service.getCurrentByIntake('missing-intake')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when no current profile found', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({ id: 'intake-1' });
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findFirst.mockResolvedValue(null);

      await expect(service.getCurrentByIntake('intake-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listByIntake', () => {
    it('should list profiles by intake ordered by createdAt desc', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({ id: 'intake-1' });
      const profile1 = makeProfile({
        id: 'profile-2',
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      });
      const profile2 = makeProfile({
        id: 'profile-1',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        profile1,
        profile2,
      ]);

      const result = await service.listByIntake('intake-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('profile-2');
      expect(result[1].id).toBe('profile-1');
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).findMany).toHaveBeenCalledWith({
        where: { rightsIntakeId: 'intake-1' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should throw NotFoundException when intake not found', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);

      await expect(service.listByIntake('missing-intake')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getById', () => {
    it('should return profile detail by id with nested records', async () => {
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(profile);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'se-1',
        rightsProfileId: 'profile-1',
        provider: 'PROJECT_GUTENBERG',
        externalId: '12345',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Test Book',
        sourceLanguage: 'en',
        sourceTextType: 'ORIGINAL_TEXT',
        gutenbergStatus: 'PUBLIC_DOMAIN',
        status: 'ALLOWED',
        notesRu: 'notes',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      (prisma['rightsReview'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        {
          id: 'review-1',
          rightsProfileId: 'profile-1',
          rightsReviewImportId: 'import-1',
          status: 'IMPORTED',
          schemaVersion: '1.0',
          reviewerType: 'AI',
          overallStatus: 'PUBLISHABLE',
          publicationGate: 'ALLOW',
          confidence: 'HIGH',
          summaryRu: 'summary',
          conclusionRu: 'conclusion',
          reasoningRu: null,
          nextReviewAt: null,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ]);
      (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsEvidence'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.getById('profile-1');

      expect(result.id).toBe('profile-1');
      expect(result.rightsIntakeId).toBe('intake-1');
      expect(result.sourceEdition).toBeDefined();
      expect(result.sourceEdition!.provider).toBe('PROJECT_GUTENBERG');
      expect(result.reviews).toHaveLength(1);
      expect(result.reviews[0].id).toBe('review-1');
      expect(result.components).toEqual([]);
      expect(result.territoryDecisions).toEqual([]);
      expect(result.evidence).toEqual([]);
      expect(result.actions).toEqual([]);
      expect(
        (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany,
      ).toHaveBeenCalledWith({
        where: { rightsProfileId: 'profile-1' },
        include: {
          territoryAssessments: {
            orderBy: [{ countryCode: 'asc' }],
          },
          contributors: {
            include: {
              person: true,
            },
          },
        },
      });
    });

    it('should return nested component territory assessments and normalize missing arrays', async () => {
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(profile);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['rightsReview'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        {
          id: 'component-1',
          rightsProfileId: 'profile-1',
          componentType: 'TRANSLATION',
          titleRu: 'Перевод',
          status: 'COPYRIGHTED',
          requiredAction: 'OBTAIN_LICENSE',
          confidence: 'MEDIUM',
          notesRu: null,
          territoryAssessments: [
            {
              id: 'assessment-1',
              rightsComponentId: 'component-1',
              countryCode: 'GB',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
              reasonRu: 'Перевод защищён.',
              legalBasisRu: 'Translation term.',
              publicDomainFromYear: null,
              rightsExpireAt: new Date('2031-01-01T00:00:00.000Z'),
              sourceEvidenceIds: ['evidence-1'],
              confidence: 'MEDIUM',
              notesRu: null,
              createdAt: new Date('2026-07-27T00:00:00.000Z'),
              updatedAt: new Date('2026-07-27T00:00:00.000Z'),
            },
          ],
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
          updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        },
        {
          id: 'component-2',
          rightsProfileId: 'profile-1',
          componentType: 'COVER',
          titleRu: 'Обложка',
          status: 'OWNED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          notesRu: null,
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
          updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        },
      ]);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsEvidence'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.getById('profile-1');

      expect(result.components[0].territoryAssessments).toEqual([
        expect.objectContaining({
          id: 'assessment-1',
          countryCode: 'GB',
          sourceEvidenceIds: ['evidence-1'],
          rightsExpireAt: '2031-01-01T00:00:00.000Z',
        }),
      ]);
      expect(result.components[1].territoryAssessments).toEqual([]);
    });

    it('should throw NotFoundException when profile not found', async () => {
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);

      await expect(service.getById('missing-profile')).rejects.toThrow(NotFoundException);
    });
  });
  // Phase 15: licenses in profile detail
  describe('licenses', () => {
    const makeLicenseRow = () => ({
      id: 'lic-1',
      licenseKey: 'license:penguin-2019',
      licenseType: 'DIRECT_LICENSE',
      status: 'ACTIVE',
      title: 'Лицензия на перевод',
      licensor: 'Penguin Random House',
      licensee: null,
      rightsHolder: null,
      referenceNumber: null,
      grantedAt: null,
      effectiveFrom: null,
      expiresAt: null,
      isPerpetual: true,
      territoryScope: 'COUNTRY_LIST',
      countryCodes: ['ES'],
      excludedCountryCodes: null,
      languageCodes: ['es'],
      mediaFormats: null,
      commercialUseAllowed: true,
      modificationAllowed: false,
      translationAllowed: true,
      sublicensingAllowed: false,
      attributionRequired: false,
      requiredAttributionText: null,
      exclusive: false,
      revocable: true,
      revokedAt: null,
      revokedByUserId: null,
      revocationReasonRu: null,
      confidence: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    it('returns licenses, coverage and metrics in the profile detail', async () => {
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        makeProfile(),
      );
      (prisma['sourceEdition'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(null);
      (prisma['rightsReview'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsComponent'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        {
          id: 'component-1',
          rightsProfileId: 'profile-1',
          componentType: 'TRANSLATION',
          titleRu: 'Перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          territoryAssessments: [],
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ]);
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        {
          id: 'decision-1',
          rightsProfileId: 'profile-1',
          countryCode: 'ES',
          finalStatus: 'ALLOWED_BY_LICENSE',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          geoBlockScope: null,
          reasonRu: 'Публикация разрешена на основании лицензии.',
          legalBasisRu: null,
          confidence: 'HIGH',
          nextReviewAt: null,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ]);
      (prisma['rightsEvidence'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsAction'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsLicenseLink'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        {
          rightsLicenseId: 'lic-1',
          rightsComponentId: 'component-1',
          componentTerritoryAssessmentId: null,
          rightsLicense: makeLicenseRow(),
        },
      ]);
      (prisma['rightsLicense'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        makeLicenseRow(),
      ]);

      const result = await service.getById('profile-1');

      expect(result.licenses).toHaveLength(1);
      expect(result.licenses?.[0].effectiveStatus).toBe('ACTIVE');
      expect(result.licensesCount).toBe(1);
      expect(result.activeLicensesCount).toBe(1);
      expect(result.expiredLicensesCount).toBe(0);
      expect(result.revokedLicensesCount).toBe(0);
      expect(result.licenseCoverage?.status).toBe('COVERED');
      expect(result.licenseRequiredCountriesCount).toBe(1);
      expect(result.licenseCoveredCountriesCount).toBe(1);
      expect(result.licenseUncoveredCountriesCount).toBe(0);
      expect(result.components[0].licenses).toHaveLength(1);
    });
  });
});
