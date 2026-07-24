import { RightsReviewImportService } from './rights-review-import.service';
import { RightsReviewImportValidator } from './rights-review-import.validator';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';

interface PrismaStub {
  rightsIntake: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  rightsReviewImport: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

const createPrismaStub = (): PrismaStub => ({
  rightsIntake: { findUnique: jest.fn(), update: jest.fn() },
  rightsReviewImport: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
});

const createDto = (overrides: Record<string, unknown> = {}) => ({
  reportJson: {
    schemaVersion: '1.0',
    intakeId: 'intake-1',
    overallStatus: 'PUBLISHABLE',
    publicationGate: 'ALLOW',
    summaryRu: 'test',
    conclusionRu: 'test',
    sourceAssessment: {
      provider: 'PROJECT_GUTENBERG',
      status: 'ALLOWED',
      sourceTextType: 'ORIGINAL_TEXT',
    },
    languageAssessments: [
      {
        languageCode: 'en',
        status: 'ALLOWED',
        translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        requiresGeoBlock: false,
      },
    ],
    componentAssessments: [],
    territoryDecisions: [
      {
        countryCode: 'US',
        finalStatus: 'ALLOWED',
        accessPolicy: 'ALLOW',
        geoBlockRequired: false,
        reasonRu: 'PD',
        confidence: 'HIGH',
      },
    ],
    requiredActions: [],
    evidence: [],
    confidence: 'HIGH',
  },
  ...overrides,
});

const mockIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'READY_FOR_AGENT',
  candidateTitle: 'Test',
  candidateAuthor: 'Test',
  targetLanguages: ['en'],
  targetCountryCodes: ['US'],
  ...overrides,
});

describe('RightsReviewImportService', () => {
  let service: RightsReviewImportService;
  let prisma: PrismaStub;
  let validator: RightsReviewImportValidator;

  beforeEach(() => {
    prisma = createPrismaStub();
    validator = new RightsReviewImportValidator();
    service = new RightsReviewImportService(prisma as unknown as PrismaService, validator);
  });

  it('valid import creates VALIDATED', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
    prisma.rightsReviewImport.create.mockResolvedValue({
      id: 'import-1',
      importStatus: 'VALIDATED',
      isCurrent: true,
    });

    const result = await service.create('intake-1', createDto(), 'user-1');
    expect(result.importStatus).toBe('VALIDATED');
  });

  it('valid import sets isCurrent = true', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
    prisma.rightsReviewImport.create.mockResolvedValue({
      id: 'import-1',
      importStatus: 'VALIDATED',
      isCurrent: true,
    });

    const result = await service.create('intake-1', createDto(), 'user-1');
    expect(result.isCurrent).toBe(true);
  });

  it('valid import updates intake status to REVIEW_IMPORTED', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
    prisma.rightsReviewImport.create.mockResolvedValue({ id: 'import-1' });
    prisma.rightsIntake.update.mockResolvedValue({});

    await service.create('intake-1', createDto(), 'user-1');
    expect(prisma.rightsIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'intake-1' },
        data: { workflowStatus: 'REVIEW_IMPORTED' },
      }),
    );
  });

  it('valid import supersedes previous current import', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
    prisma.rightsReviewImport.create.mockResolvedValue({
      id: 'import-2',
      importStatus: 'VALIDATED',
    });

    await service.create('intake-1', createDto(), 'user-1');
    expect(prisma.rightsReviewImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { rightsIntakeId: 'intake-1', isCurrent: true },
      }),
    );
  });

  it('invalid import creates VALIDATION_FAILED', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.create.mockResolvedValue({
      id: 'import-1',
      importStatus: 'VALIDATION_FAILED',
    });

    const result = await service.create(
      'intake-1',
      createDto({ reportJson: { bad: 'data' } }),
      'user-1',
    );
    expect(result.importStatus).toBe('VALIDATION_FAILED');
  });

  it('invalid import does not change intake status', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.create.mockResolvedValue({ id: 'import-1' });

    await service.create('intake-1', createDto({ reportJson: { bad: 'data' } }), 'user-1');
    expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
  });

  it('invalid import does not supersede previous valid import', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.create.mockResolvedValue({ id: 'import-1' });

    await service.create('intake-1', createDto({ reportJson: { bad: 'data' } }), 'user-1');
    expect(prisma.rightsReviewImport.updateMany).not.toHaveBeenCalled();
  });

  it('import forbidden for DRAFT', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake({ workflowStatus: 'DRAFT' }));
    await expect(service.create('intake-1', createDto(), 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('import forbidden for ARCHIVED', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake({ workflowStatus: 'ARCHIVED' }));
    await expect(service.create('intake-1', createDto(), 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('list returns paginated imports without full reportJson', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.count.mockResolvedValue(1);
    prisma.rightsReviewImport.findMany.mockResolvedValue([
      {
        id: 'import-1',
        rightsIntakeId: 'intake-1',
        schemaVersion: '1.0',
        importStatus: 'VALIDATED',
        isCurrent: true,
        sourceFileName: null,
        importedByUserId: null,
        supersededAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prisma.$transaction.mockImplementation(async (arr: unknown[]) =>
      Promise.all(arr as Array<Promise<unknown>>),
    );

    const result = await service.listByIntake('intake-1', {});
    expect(result.items[0]).not.toHaveProperty('reportJson');
    expect(result.total).toBe(1);
  });

  it('get returns full import', async () => {
    const now = new Date();
    prisma.rightsReviewImport.findUnique.mockResolvedValue({
      id: 'import-1',
      rightsIntakeId: 'intake-1',
      schemaVersion: '1.0',
      importStatus: 'VALIDATED',
      isCurrent: true,
      reportJson: { foo: 'bar' },
      reportMarkdown: null,
      rawAgentOutput: null,
      sourceFileName: null,
      reportJsonSha256: 'abc',
      reportMarkdownSha256: null,
      rawAgentOutputSha256: null,
      validationErrors: null,
      validationWarnings: null,
      importedByUserId: null,
      supersededAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await service.getById('import-1');
    expect(result.id).toBe('import-1');
    expect(result.reportJson).toEqual({ foo: 'bar' });
    expect(result.reportJsonSha256).toBe('abc');
  });

  it('hashes are generated', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
    prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
    prisma.rightsReviewImport.create.mockImplementation(
      (args: { data: Record<string, unknown> }) => args.data,
    );

    const result = await service.create(
      'intake-1',
      createDto({ reportMarkdown: '# hello', rawAgentOutput: 'raw output' }),
      'user-1',
    );
    expect(result.reportJsonSha256).toBeTruthy();
    expect(result.reportMarkdownSha256).toBeTruthy();
    expect(result.rawAgentOutputSha256).toBeTruthy();
  });
});
