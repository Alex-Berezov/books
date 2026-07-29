import { RightsMaterializationService } from './rights-materialization.service';
import { ComponentTerritoryAggregationService } from './component-territory-aggregation.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { RightsClaimEnforcementService } from '../rights-claims/rights-claim-enforcement.service';
import { PersonResolverService } from '../persons/person-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const makeValidReportJson = (): Record<string, unknown> => ({
  schemaVersion: '1.0',
  intakeId: 'intake-1',
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  summaryRu: 'test summary',
  conclusionRu: 'test conclusion',
  reasoningRu: 'test reasoning',
  nextReviewAt: '2027-01-01T00:00:00.000Z',
  sourceAssessment: {
    provider: 'PROJECT_GUTENBERG',
    status: 'ALLOWED',
    sourceTextType: 'ORIGINAL_TEXT',
    externalId: '12345',
    sourceUrl: 'https://example.com',
    sourceTitle: 'Test Book',
    sourceLanguage: 'en',
    gutenbergStatus: 'PUBLIC_DOMAIN',
    notesRu: 'test notes',
  },
  componentAssessments: [
    {
      componentType: 'ORIGINAL_TEXT',
      titleRu: 'Original text',
      status: 'PUBLIC_DOMAIN',
      requiredAction: 'KEEP',
      confidence: 'HIGH',
    },
  ],
  territoryDecisions: [
    {
      countryCode: 'US',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'Public domain in US',
      confidence: 'HIGH',
    },
    {
      countryCode: 'FR',
      finalStatus: 'ALLOWED',
      accessPolicy: 'ALLOW',
      geoBlockRequired: false,
      reasonRu: 'Public domain in FR',
      confidence: 'HIGH',
    },
  ],
  evidence: [
    {
      evidenceType: 'GUTENBERG_PAGE',
      sourceLevel: 'PRIMARY',
      title: 'Project Gutenberg page',
      authority: 'PG',
      url: 'https://gutenberg.org/ebooks/12345',
      jurisdictionCode: 'US',
      accessedAt: '2026-06-01T00:00:00.000Z',
      relevantExcerpt: 'This book is in the public domain',
      summaryRu: 'Страница PG',
    },
  ],
  requiredActions: [
    {
      actionType: 'REMOVE_COMPONENT',
      descriptionRu: 'Remove preface',
      affectedCountryCodes: ['US'],
      isBlocking: false,
      suggestedStatus: 'PENDING',
    },
  ],
});

const makeImportRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'import-1',
  rightsIntakeId: 'intake-1',
  importStatus: 'VALIDATED',
  isCurrent: true,
  reportJson: makeValidReportJson(),
  ...overrides,
});

const makeIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'REVIEW_IMPORTED',
  candidateTitle: 'Test Book',
  targetCountryCodes: ['US', 'FR'],
  ...overrides,
});

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
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  ...overrides,
});

interface PrismaStub {
  rightsIntake: { findUnique: jest.Mock };
  $transaction: jest.Mock;
  [key: string]: unknown;
}

const createPrismaStub = (): PrismaStub => {
  const stub: Record<string, unknown> = {
    rightsIntake: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  };

  stub['rightsReviewImport'] = { findUnique: jest.fn() };
  stub['rightsProfile'] = {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  };
  stub['rightsReview'] = {
    updateMany: jest.fn(),
    // Phase 18: the chain linking below needs a review id back from `create`.
    create: jest.fn().mockResolvedValue({ id: 'review-1' }),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'review-1' }),
  };
  stub['sourceEdition'] = { create: jest.fn(), findUnique: jest.fn() };
  stub['editionRights'] = { create: jest.fn() };
  stub['rightsComponent'] = { create: jest.fn() };
  stub['componentTerritoryAssessment'] = { create: jest.fn() };
  stub['territoryDecision'] = { create: jest.fn() };
  stub['rightsEvidence'] = { create: jest.fn() };
  stub['rightsAction'] = { create: jest.fn() };
  stub['bookVersion'] = { findUnique: jest.fn(), update: jest.fn() };
  stub['geoBlockRule'] = { findMany: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() };
  stub['rightsProfileContributor'] = { create: jest.fn(), update: jest.fn() };
  stub['rightsLicense'] = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
  };
  stub['rightsLicenseLink'] = {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  };
  stub['rightsLicenseEvent'] = { create: jest.fn() };

  return stub as unknown as PrismaStub;
};

describe('RightsMaterializationService', () => {
  let service: RightsMaterializationService;
  let prisma: PrismaStub;
  let personResolver: { resolveOrCreatePerson: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    personResolver = {
      resolveOrCreatePerson: jest.fn().mockResolvedValue({ id: 'person-1' }),
    };
    service = new RightsMaterializationService(
      prisma as unknown as PrismaService,
      new ComponentTerritoryAggregationService(),
      personResolver as unknown as PersonResolverService,
    );
    (prisma['rightsComponent'] as Record<string, jest.Mock>).create.mockResolvedValue({
      id: 'component-1',
    });
    (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
      id: 'source-edition-1',
    });
  });

  function setupTransaction() {
    prisma.$transaction.mockImplementation((fn: (tx: Record<string, unknown>) => unknown) =>
      fn(prisma as unknown as Record<string, unknown>),
    );
  }

  function setupBasicMocks(importOverrides: Record<string, unknown> = {}) {
    (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
      makeImportRecord(importOverrides),
    );
    prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
    (prisma['rightsReview'] as Record<string, jest.Mock>).findFirst.mockResolvedValue(null);
  }

  describe('materializeFromImport', () => {
    it('should throw NotFoundException when import not found', async () => {
      (prisma['rightsReviewImport'] as Record<string, jest.Mock>).findUnique.mockResolvedValue(
        null,
      );

      await expect(service.materializeFromImport('missing-import')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when import status is VALIDATION_FAILED', async () => {
      setupBasicMocks({ importStatus: 'VALIDATION_FAILED' });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when import status is SUPERSEDED', async () => {
      setupBasicMocks({ importStatus: 'SUPERSEDED' });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when import is not current', async () => {
      setupBasicMocks({ isCurrent: false });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when intake status is not REVIEW_IMPORTED', async () => {
      setupBasicMocks();
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'DRAFT' }));

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when reportJson.schemaVersion is not 1.0', async () => {
      setupBasicMocks({
        reportJson: { ...makeValidReportJson(), schemaVersion: '2.0' },
      });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when reportJson.intakeId does not match', async () => {
      setupBasicMocks({
        reportJson: { ...makeValidReportJson(), intakeId: 'other-intake' },
      });

      await expect(service.materializeFromImport('import-1')).rejects.toThrow(BadRequestException);
    });

    it('should create RightsProfile, RightsReview, SourceEdition, EditionRights', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      const result = await service.materializeFromImport('import-1');

      expect(prisma['rightsProfile'] as Record<string, jest.Mock>).toBeDefined();
      expect(
        (prisma['rightsProfile'] as Record<string, jest.Mock>).updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rightsIntakeId: 'intake-1', isCurrent: true },
        }),
      );
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsIntakeId: 'intake-1',
            currentReviewImportId: 'import-1',
            status: 'HUMAN_REVIEW_REQUIRED',
            isCurrent: true,
          }),
        }),
      );
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            rightsReviewImportId: 'import-1',
            status: 'HUMAN_REVIEW_REQUIRED',
          }),
        }),
      );
      // Phase 18: the first review of an intake roots its own chain.
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: {
          previousReviewId: null,
          chainRootReviewId: 'review-1',
          revisionNumber: 1,
        },
      });
      expect((prisma['sourceEdition'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            provider: 'PROJECT_GUTENBERG',
          }),
        }),
      );
      expect((prisma['editionRights'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceEditionId: expect.any(String),
          }),
        }),
      );
      expect(result).toEqual(profile);
    });

    it('should update intake workflowStatus to HUMAN_REVIEW_REQUIRED and clear approvedReviewId', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsIntake'] as Record<string, jest.Mock>).update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'intake-1' },
          data: {
            workflowStatus: 'HUMAN_REVIEW_REQUIRED',
            approvedReviewId: null,
          },
        }),
      );
    });

    it('should create TerritoryDecision records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledTimes(2);
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            countryCode: 'US',
            finalStatus: 'ALLOWED',
          }),
        }),
      );
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            countryCode: 'FR',
            finalStatus: 'ALLOWED',
          }),
        }),
      );
    });

    it('should create RightsComponent records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsComponent'] as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(
        1,
      );
      expect((prisma['rightsComponent'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            componentType: 'ORIGINAL_TEXT',
            status: 'PUBLIC_DOMAIN',
          }),
        }),
      );
    });

    it('should create RightsEvidence records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(
        1,
      );
      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            evidenceType: 'GUTENBERG_PAGE',
            title: 'Project Gutenberg page',
          }),
        }),
      );
    });

    it('should create RightsAction records from reportJson', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledTimes(1);
      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            actionType: 'REMOVE_COMPONENT',
            status: 'PENDING',
          }),
        }),
      );
    });

    it('should supersede previous current profile on new materialization', async () => {
      setupBasicMocks();
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([
        { id: 'old-profile-1' },
      ]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect(
        (prisma['rightsProfile'] as Record<string, jest.Mock>).updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rightsIntakeId: 'intake-1', isCurrent: true },
          data: expect.objectContaining({
            isCurrent: false,
            status: 'SUPERSEDED',
          }),
        }),
      );
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rightsProfileId: { in: ['old-profile-1'] } },
          data: { status: 'SUPERSEDED' },
        }),
      );
    });

    it('should be idempotent for same importId (return existing profile)', async () => {
      setupBasicMocks();
      const existingProfile = { id: 'existing-profile-1', rightsIntakeId: 'intake-1' };
      (prisma['rightsReview'] as Record<string, jest.Mock>).findFirst.mockResolvedValue({
        rightsProfile: existingProfile,
      });

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(existingProfile);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
    });

    it('should handle empty optional arrays (no components, evidence, actions)', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [];
      reportJson.evidence = [];
      reportJson.requiredActions = [];
      setupBasicMocks({ reportJson });
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(profile);
      expect(
        (prisma['rightsComponent'] as Record<string, jest.Mock>).create,
      ).not.toHaveBeenCalled();
      expect((prisma['rightsEvidence'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledTimes(2);
    });

    it('should handle null/empty optional dates gracefully', async () => {
      const reportJson = makeValidReportJson();
      reportJson.nextReviewAt = null;
      const profile = makeProfile({ nextReviewAt: null });
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(profile);
      expect((prisma['rightsProfile'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nextReviewAt: null,
          }),
        }),
      );
    });

    it('should handle missing sourceAssessment gracefully', async () => {
      const reportJson = makeValidReportJson();
      delete reportJson.sourceAssessment;
      setupBasicMocks({ reportJson });
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      const result = await service.materializeFromImport('import-1');

      expect(result).toEqual(profile);
      expect((prisma['sourceEdition'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
      expect((prisma['editionRights'] as Record<string, jest.Mock>).create).not.toHaveBeenCalled();
    });

    it('should create component territory assessments and aggregate a conservative decision', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Перевод',
          status: 'COPYRIGHTED',
          requiredAction: 'OBTAIN_LICENSE',
          confidence: 'HIGH',
          territoryAssessments: [
            {
              countryCode: 'gb',
              status: 'BLOCKED',
              accessPolicy: 'BLOCK',
              geoBlockRequired: true,
              reasonRu: 'Перевод защищён.',
              legalBasisRu: 'Translation copyright term.',
              rightsExpireAt: '2031-01-01T00:00:00.000Z',
              publicDomainFromYear: 2032,
              sourceEvidenceIds: ['evidence-gb'],
              confidence: 'MEDIUM',
              notesRu: 'Проверить автора перевода.',
            },
          ],
        },
      ];
      reportJson.territoryDecisions = [
        {
          countryCode: 'GB',
          finalStatus: 'ALLOWED',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          reasonRu: 'Top-level allow.',
          confidence: 'HIGH',
        },
      ];
      setupBasicMocks({ reportJson });
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: ['GB'] }));
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      await service.materializeFromImport('import-1');

      expect(
        (prisma['componentTerritoryAssessment'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rightsComponentId: 'component-1',
          countryCode: 'GB',
          confidence: 'MEDIUM',
          sourceEvidenceIds: ['evidence-gb'],
          rightsExpireAt: new Date('2031-01-01T00:00:00.000Z'),
        }),
      });
      expect(
        (prisma['territoryDecision'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          countryCode: 'GB',
          finalStatus: 'BLOCKED',
          accessPolicy: 'BLOCK',
          geoBlockRequired: true,
          geoBlockScope: 'TEXT_READER',
        }),
      });

      // Verify GeoBlockRule generation pipeline from the materialized TerritoryDecision
      const materializedDecision = (
        prisma['territoryDecision'] as Record<string, jest.Mock>
      ).create.mock.calls.find(
        (call: Array<{ data: { countryCode: string } }>) => call[0]?.data?.countryCode === 'GB',
      )?.[0]?.data;

      expect(materializedDecision).toBeDefined();
      expect(materializedDecision.geoBlockRequired).toBe(true);
      expect(materializedDecision.geoBlockScope).toBe('TEXT_READER');

      // Test GeoBlockRule projection from decision
      const geoBlockRuleService = new GeoBlockRuleService(
        prisma as unknown as PrismaService,
        {
          checkClaimAccess: jest.fn().mockResolvedValue({
            blocked: false,
            countryCode: null,
            scope: 'TEXT_READER',
            matchedBlockId: null,
            reasonCode: null,
            messageRu: null,
          }),
        } as unknown as RightsClaimEnforcementService,
      );
      (prisma['bookVersion'] as Record<string, jest.Mock>).findUnique.mockResolvedValue({
        id: 'v1',
        bookId: 'b1',
        rightsProfileId: 'profile-1',
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: false,
      });
      (prisma['territoryDecision'] as Record<string, jest.Mock>).findMany = jest
        .fn()
        .mockResolvedValue([
          {
            id: 'td-gb',
            rightsProfileId: 'profile-1',
            countryCode: 'GB',
            finalStatus: 'BLOCKED',
            accessPolicy: 'BLOCK',
            geoBlockRequired: true,
            geoBlockScope: 'TEXT_READER',
            reasonRu: 'Translation copyright active in GB',
            legalBasisRu: 'UK Copyright Law',
          },
        ]);
      (prisma['geoBlockRule'] as Record<string, jest.Mock>).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 0 });
      (prisma['geoBlockRule'] as Record<string, jest.Mock>).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'rule-gb' });
      (prisma['geoBlockRule'] as Record<string, jest.Mock>).findMany = jest.fn().mockResolvedValue([
        {
          id: 'rule-gb',
          bookId: 'b1',
          bookVersionId: 'v1',
          rightsProfileId: 'profile-1',
          territoryDecisionId: 'td-gb',
          scope: 'TEXT_READER',
          countryCode: 'GB',
          accessPolicy: 'BLOCK',
          sourceFinalStatus: 'BLOCKED',
          isActive: true,
          reasonRu: 'Translation copyright active in GB',
          legalBasisRu: 'UK Copyright Law',
          generatedFrom: 'TERRITORY_DECISION',
          generatedAt: new Date(),
          verifiedAt: null,
          verifiedByUserId: null,
          verificationNotesRu: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      (prisma['bookVersion'] as Record<string, jest.Mock>).update = jest.fn().mockResolvedValue({});

      const rulesResult = await geoBlockRuleService.generateRulesForVersion('v1');
      expect(rulesResult.summary.blockedCountries).toContain('GB');
      expect(rulesResult.summary.scopes).toContain('TEXT_READER');
      expect(rulesResult.rules[0].countryCode).toBe('GB');
      expect(rulesResult.rules[0].scope).toBe('TEXT_READER');
    });

    it('should inherit component confidence for a territory assessment', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [
        {
          componentType: 'ORIGINAL_TEXT',
          titleRu: 'Оригинальный текст',
          status: 'PUBLIC_DOMAIN',
          requiredAction: 'KEEP',
          confidence: 'LOW',
          territoryAssessments: [
            {
              countryCode: 'US',
              status: 'ALLOWED',
              accessPolicy: 'ALLOW',
              geoBlockRequired: false,
            },
          ],
        },
      ];
      setupBasicMocks({ reportJson });
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: ['US'] }));
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      await service.materializeFromImport('import-1');

      expect(
        (prisma['componentTerritoryAssessment'] as Record<string, jest.Mock>).create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          countryCode: 'US',
          confidence: 'LOW',
        }),
      });
    });

    it('should set suggestedStatus to PENDING when invalid', async () => {
      const reportJson = makeValidReportJson();
      reportJson.requiredActions = [
        {
          actionType: 'REMOVE_COMPONENT',
          descriptionRu: 'Remove preface',
          affectedCountryCodes: ['US'],
          isBlocking: false,
          suggestedStatus: 'INVALID_STATUS',
        },
      ];
      setupBasicMocks({ reportJson });
      setupTransaction();
      const profile = makeProfile();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(profile);
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['sourceEdition'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'source-edition-1',
      });

      await service.materializeFromImport('import-1');

      expect((prisma['rightsAction'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actionType: 'REMOVE_COMPONENT',
            status: 'PENDING',
          }),
        }),
      );
    });
  });

  describe('materializeFromImport — contributors', () => {
    const rpc = () => prisma['rightsProfileContributor'] as Record<string, jest.Mock>;

    const createdContributorData = () =>
      rpc().create.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);

    const setupContributorScenario = (reportJson: Record<string, unknown>) => {
      setupBasicMocks({ reportJson });
      setupTransaction();
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);

      let componentIndex = 0;
      (prisma['rightsComponent'] as Record<string, jest.Mock>).create.mockImplementation(() =>
        Promise.resolve({ id: `component-${++componentIndex}` }),
      );

      let contributorIndex = 0;
      rpc().create.mockImplementation(() => Promise.resolve({ id: `rpc-${++contributorIndex}` }));

      personResolver.resolveOrCreatePerson.mockImplementation(
        (input: { canonicalName?: string; displayName: string }) =>
          Promise.resolve({ id: `person-${input.canonicalName ?? input.displayName}` }),
      );
    };

    it('should materialize sourceAssessment.contributors as profile-level contributors', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [
        {
          displayName: 'Mark Twain',
          role: 'AUTHOR',
          birthYear: 1835,
          deathYear: 1910,
          viafId: '50566653',
          notesRu: 'Автор оригинала.',
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
      expect(createdContributorData()[0]).toEqual(
        expect.objectContaining({
          rightsProfileId: 'profile-1',
          rightsComponentId: null,
          personId: 'person-Mark Twain',
          role: 'AUTHOR',
          displayName: 'Mark Twain',
          birthYear: 1835,
          deathYear: 1910,
          viafId: '50566653',
          notesRu: 'Автор оригинала.',
        }),
      );
    });

    it('should materialize inline component contributors bound to the created component', async () => {
      const reportJson = makeValidReportJson();
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributors: [{ displayName: 'Juan Pérez', role: 'TRANSLATOR' }],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(createdContributorData()).toEqual([
        expect.objectContaining({
          rightsComponentId: 'component-1',
          personId: 'person-Juan Pérez',
          role: 'TRANSLATOR',
          displayName: 'Juan Pérez',
        }),
      ]);
    });

    it('should map legacy contributor fields and unknown roles', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [
        {
          displayName: 'Anna Karlsson',
          originalName: 'Karlsson, Anna',
          nationalityCountry: 'SE',
          pseudonym: 'A. K.',
          identityConfidence: 'PROBABLE',
          role: 'PROOFREADER',
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(createdContributorData()[0]).toEqual(
        expect.objectContaining({
          displayName: 'Anna Karlsson',
          canonicalName: 'Karlsson, Anna',
          nationalityCountryCode: 'SE',
          creditedName: 'A. K.',
          confidence: 'MEDIUM',
          role: 'OTHER',
          roleOtherRu: 'PROOFREADER',
        }),
      );
    });

    it('should attach a top-level contributor to a component via contributorRefs without duplicating it', async () => {
      const reportJson = makeValidReportJson();
      reportJson.contributors = [
        { key: 'translator:juan', role: 'TRANSLATOR', displayName: 'Juan Pérez' },
      ];
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [
            { contributorKey: 'translator:juan', role: 'TRANSLATOR', creditedName: 'J. Pérez' },
          ],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
      expect(rpc().update).toHaveBeenCalledWith({
        where: { id: 'rpc-1' },
        data: {
          rightsComponentId: 'component-1',
          creditedName: 'J. Pérez',
          notesRu: null,
        },
      });
    });

    it('should create an extra contributor row when the same contributor is referenced by two components', async () => {
      const reportJson = makeValidReportJson();
      reportJson.contributors = [
        { key: 'translator:juan', role: 'TRANSLATOR', displayName: 'Juan Pérez' },
      ];
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [{ contributorKey: 'translator:juan' }],
        },
        {
          componentType: 'ANNOTATIONS',
          titleRu: 'Комментарии переводчика',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [{ contributorKey: 'translator:juan' }],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().update).toHaveBeenCalledTimes(1);
      expect(rpc().create).toHaveBeenCalledTimes(2);
      expect(createdContributorData()[1]).toEqual(
        expect.objectContaining({
          rightsComponentId: 'component-2',
          role: 'TRANSLATOR',
          displayName: 'Juan Pérez',
        }),
      );
    });

    it('should not duplicate a contributor that is both referenced and inlined on the same component', async () => {
      const reportJson = makeValidReportJson();
      reportJson.contributors = [
        { key: 'translator:juan', role: 'TRANSLATOR', displayName: 'Juan Pérez' },
      ];
      reportJson.componentAssessments = [
        {
          componentType: 'TRANSLATION',
          titleRu: 'Испанский перевод',
          status: 'LICENSED',
          requiredAction: 'KEEP',
          confidence: 'HIGH',
          contributorRefs: [{ contributorKey: 'translator:juan' }],
          contributors: [{ displayName: 'Juan Pérez', role: 'TRANSLATOR' }],
        },
      ];
      setupContributorScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
    });

    it('should create a fallback AUTHOR contributor from the intake candidate author', async () => {
      setupContributorScenario(makeValidReportJson());
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ candidateAuthor: 'Mark Twain' }),
      );

      await service.materializeFromImport('import-1');

      expect(createdContributorData()).toEqual([
        expect.objectContaining({
          rightsProfileId: 'profile-1',
          rightsComponentId: null,
          role: 'AUTHOR',
          displayName: 'Mark Twain',
          canonicalName: 'Mark Twain',
        }),
      ]);
    });

    it('should not create the fallback contributor when the report already provides contributors', async () => {
      const reportJson = makeValidReportJson();
      const sourceAssessment = reportJson.sourceAssessment as Record<string, unknown>;
      sourceAssessment['contributors'] = [{ displayName: 'Juan Pérez', role: 'TRANSLATOR' }];
      setupContributorScenario(reportJson);
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ candidateAuthor: 'Mark Twain' }),
      );

      await service.materializeFromImport('import-1');

      expect(rpc().create).toHaveBeenCalledTimes(1);
      expect(createdContributorData()[0]).toEqual(
        expect.objectContaining({ displayName: 'Juan Pérez', role: 'TRANSLATOR' }),
      );
    });

    it('should not touch contributors when the report has none and the intake has no candidate author', async () => {
      setupContributorScenario(makeValidReportJson());

      await service.materializeFromImport('import-1');

      expect(rpc().create).not.toHaveBeenCalled();
      expect(rpc().update).not.toHaveBeenCalled();
    });
  });

  // Phase 15: licenses[] materialization
  describe('licenses', () => {
    const rl = () => prisma['rightsLicense'] as Record<string, jest.Mock>;
    const rll = () => prisma['rightsLicenseLink'] as Record<string, jest.Mock>;
    const rle = () => prisma['rightsLicenseEvent'] as Record<string, jest.Mock>;

    const linkCalls = () =>
      rll().create.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);

    const withLicenses = (): Record<string, unknown> => {
      const reportJson = makeValidReportJson();
      reportJson['licenses'] = [
        {
          key: 'license:penguin-2019',
          title: 'Лицензия на перевод',
          licensor: 'Penguin Random House',
          status: 'ACTIVE',
          territoryScope: 'COUNTRY_LIST',
          countryCodes: ['FR'],
          languageCodes: ['fr'],
          documentSha256: 'a'.repeat(64),
        },
      ];
      return reportJson;
    };

    const setupLicenseScenario = (reportJson: Record<string, unknown>) => {
      setupTransaction();
      setupBasicMocks({ reportJson });
      (prisma['rightsProfile'] as Record<string, jest.Mock>).create.mockResolvedValue(
        makeProfile(),
      );
      (prisma['rightsProfile'] as Record<string, jest.Mock>).findMany.mockResolvedValue([]);
      (prisma['rightsReview'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'review-1',
      });
      (
        prisma['componentTerritoryAssessment'] as Record<string, jest.Mock>
      ).create.mockResolvedValue({ id: 'assessment-1' });
      (prisma['territoryDecision'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'decision-1',
      });
      (prisma['rightsEvidence'] as Record<string, jest.Mock>).create.mockResolvedValue({
        id: 'evidence-1',
      });
      rl().create.mockResolvedValue({ id: 'lic-1' });
    };

    it('creates licenses from the report and links them to the profile', async () => {
      setupLicenseScenario(withLicenses());

      await service.materializeFromImport('import-1');

      expect(rl().create).toHaveBeenCalledTimes(1);
      expect(rle().create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'IMPORTED_FROM_REVIEW' }),
        }),
      );
      expect(linkCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ linkType: 'RIGHTS_PROFILE', rightsProfileId: 'profile-1' }),
        ]),
      );
    });

    it('reuses an existing license with the same licenseKey instead of creating a duplicate', async () => {
      setupLicenseScenario(withLicenses());
      rl().findFirst.mockResolvedValue({ id: 'lic-existing', title: 'Существующая' });

      await service.materializeFromImport('import-1');

      expect(rl().create).not.toHaveBeenCalled();
      expect(linkCalls()[0]).toEqual(expect.objectContaining({ rightsLicenseId: 'lic-existing' }));
    });

    it('links component licenseRefs to the created component', async () => {
      const reportJson = withLicenses();
      (reportJson['componentAssessments'] as Array<Record<string, unknown>>)[0]['licenseRefs'] = [
        'license:penguin-2019',
      ];
      setupLicenseScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(linkCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            linkType: 'RIGHTS_COMPONENT',
            rightsComponentId: 'component-1',
          }),
        ]),
      );
    });

    it('links a territory assessment licenseRef with the covered country', async () => {
      const reportJson = withLicenses();
      (reportJson['componentAssessments'] as Array<Record<string, unknown>>)[0][
        'territoryAssessments'
      ] = [
        {
          countryCode: 'FR',
          status: 'ALLOWED_BY_LICENSE',
          accessPolicy: 'ALLOW',
          geoBlockRequired: false,
          licenseRef: 'license:penguin-2019',
        },
      ];
      setupLicenseScenario(reportJson);

      await service.materializeFromImport('import-1');

      expect(linkCalls()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            linkType: 'COMPONENT_TERRITORY_ASSESSMENT',
            componentTerritoryAssessmentId: 'assessment-1',
            coversCountryCodes: ['FR'],
          }),
        ]),
      );
    });

    it('creates no license rows for a legacy report without a licenses block', async () => {
      setupLicenseScenario(makeValidReportJson());

      await service.materializeFromImport('import-1');

      expect(rl().create).not.toHaveBeenCalled();
      expect(rll().create).not.toHaveBeenCalled();
    });
  });
});
