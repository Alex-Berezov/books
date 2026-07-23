import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RIGHTS_AGENT_MANIFEST_VERSION } from './rights-intake.constants';

interface PrismaStub {
  rightsIntake: {
    findUnique: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  rightsIntake: { findUnique: jest.fn() },
});

const makeIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'READY_FOR_AGENT',
  candidateTitle: 'Test Book',
  candidateAuthor: 'Test Author',
  originalTitle: null,
  originalLanguage: null,
  authorBirthYear: null,
  authorDeathYear: null,
  sourceProvider: 'PROJECT_GUTENBERG',
  sourceExternalId: '12345',
  sourceUrl: 'https://www.gutenberg.org/ebooks/12345',
  sourceTitle: null,
  sourceLanguage: 'en',
  sourceTextType: 'ORIGINAL_TEXT',
  targetLanguages: ['en', 'fr'],
  targetCountryCodes: ['US', 'GB', 'FR'],
  plannedContentTypes: ['TEXT', 'AUDIO'],
  plannedComponents: [],
  notesRu: null,
  ...overrides,
});

describe('RightsIntakeManifestService', () => {
  let service: RightsIntakeManifestService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    service = new RightsIntakeManifestService(prisma as unknown as PrismaService);
  });

  describe('generate', () => {
    it('generates manifest for READY_FOR_AGENT intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(manifest.manifestType).toBe('BIBLIARIS_RIGHTS_CLEARANCE_INPUT');
      expect(manifest.intake.candidateTitle).toBe('Test Book');
      expect(manifest.intake.workflowStatus).toBe('READY_FOR_AGENT');
      expect(manifest.source.provider).toBe('PROJECT_GUTENBERG');
      expect(manifest.publicationPlan.targetLanguages).toEqual(['en', 'fr']);
      expect(manifest.agentTask.requiredChecks.length).toBeGreaterThan(0);
      expect(manifest.expectedResultSchema.requiredTopLevelFields).toContain('schemaVersion');
    });

    it('throws NotFoundException when intake missing', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);

      await expect(service.generate('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for DRAFT', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'DRAFT' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for ARCHIVED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'ARCHIVED' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for APPROVED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'APPROVED' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for REVIEW_IMPORTED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'REVIEW_IMPORTED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('normalizes plannedComponents null to []', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ plannedComponents: null }));

      const manifest = await service.generate('intake-1');
      expect(manifest.publicationPlan.plannedComponents).toEqual([]);
    });

    it('includes manifestVersion = 1.0', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.manifestVersion).toBe('1.0');
    });

    it('includes expectedResultSchema.requiredTopLevelFields', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.expectedResultSchema.requiredTopLevelFields).toEqual(
        expect.arrayContaining([
          'schemaVersion',
          'intakeId',
          'overallStatus',
          'summaryRu',
          'territoryDecisions',
          'evidence',
        ]),
      );
    });

    it('throws BadRequestException if targetLanguages is not array', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ targetLanguages: 'not-an-array' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if targetCountryCodes is not array', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: null }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if plannedContentTypes is not array', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedContentTypes: { foo: 'bar' } }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for REJECTED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'REJECTED' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for BOOK_CREATED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'BOOK_CREATED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for HUMAN_REVIEW_REQUIRED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'HUMAN_REVIEW_REQUIRED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('generatedAt is a valid ISO string', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(() => new Date(manifest.generatedAt)).not.toThrow();
      expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    });

    it('includes generatedBy.product and generatedBy.module', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.generatedBy.product).toBe('Bibliaris');
      expect(manifest.generatedBy.module).toBe('rights-intake');
    });
  });
});
