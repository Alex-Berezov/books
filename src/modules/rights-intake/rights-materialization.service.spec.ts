import { RightsMaterializationService } from './rights-materialization.service';
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
    rightsIntake: { findUnique: jest.fn() },
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
    create: jest.fn(),
    findFirst: jest.fn(),
  };
  stub['sourceEdition'] = { create: jest.fn(), findUnique: jest.fn() };
  stub['editionRights'] = { create: jest.fn() };
  stub['rightsComponent'] = { create: jest.fn() };
  stub['territoryDecision'] = { create: jest.fn() };
  stub['rightsEvidence'] = { create: jest.fn() };
  stub['rightsAction'] = { create: jest.fn() };

  return stub as unknown as PrismaStub;
};

describe('RightsMaterializationService', () => {
  let service: RightsMaterializationService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new RightsMaterializationService(prisma as unknown as PrismaService);
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
            status: 'IMPORTED',
            isCurrent: true,
          }),
        }),
      );
      expect((prisma['rightsReview'] as Record<string, jest.Mock>).create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rightsProfileId: 'profile-1',
            rightsReviewImportId: 'import-1',
            status: 'IMPORTED',
          }),
        }),
      );
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

      expect(result).toBe('existing-profile-1');
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
});
