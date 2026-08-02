import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RIGHTS_AGENT_MANIFEST_VERSION } from './rights-intake.constants';
import { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';

interface PrismaStub {
  rightsIntake: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  rightsIntake: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
});

/**
 * WP-9.1: манифест сохраняется в приватное хранилище прав, потому что повторный GET даёт
 * другие байты. Заглушка возвращает готовый дескриптор — сюда же смотрит тест, проверяющий,
 * что снимок манифеста записан на интейк.
 */
const createFilesStub = () => ({
  trySaveText: jest.fn().mockResolvedValue({
    storageKey: 'input-manifest/2026/08/01/manifest.json',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    contentType: 'application/json',
    fileName: 'manifest.json',
  }),
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
  let files: ReturnType<typeof createFilesStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    files = createFilesStub();
    service = new RightsIntakeManifestService(
      prisma as unknown as PrismaService,
      files as unknown as RightsFileStorageService,
    );
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

    // WP-10.3 (R4-04): фильтр статусов фазы 2 был чёрным списком и не знал о статусе фазы 19,
    // поэтому манифест выгружался посреди юридической проверки, а в `intake.workflowStatus`
    // манифеста уезжало значение, которого ТЗ фазы 2 там не допускает.
    it('throws BadRequestException for LAWYER_REVIEW_REQUIRED and stores nothing', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'LAWYER_REVIEW_REQUIRED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
      expect(files.trySaveText).not.toHaveBeenCalled();
      expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
    });

    it('normalizes plannedComponents null to []', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ plannedComponents: null }));

      const manifest = await service.generate('intake-1');
      expect(manifest.publicationPlan.plannedComponents).toEqual([]);
    });

    it('includes manifestVersion = 1.1', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.manifestVersion).toBe('1.1');
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

  /**
   * WP-9.1 (essence §15 `input_manifest_storage_key`). Манифест собирается на лету и несёт
   * `generatedAt`, поэтому повторный GET даёт другие байты: без снимка ответить «под каким
   * заданием агент писал отчёт» было бы нечем.
   */
  describe('WP-9.1: снимок манифеста', () => {
    it('сохраняет ровно те байты, которые уходят агенту', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');

      expect(files.trySaveText).toHaveBeenCalledWith(
        'input-manifest',
        JSON.stringify(manifest),
        'application/json',
        expect.stringContaining('intake-1'),
      );
    });

    it('запоминает ключ, сумму и версию на интейке', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      await service.generate('intake-1');

      const data = prisma.rightsIntake.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.manifestStorageKey).toBe('input-manifest/2026/08/01/manifest.json');
      expect(data.manifestSha256).toBe('a'.repeat(64));
      expect(data.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(data.manifestGeneratedAt).toBeInstanceOf(Date);
    });

    it('отдаёт манифест редактору даже если хранилище недоступно', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
      files.trySaveText.mockResolvedValue(null);

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
    });

    /**
     * Тот случай, ради которого запись снимка обёрнута в try/catch: код выкатили раньше
     * миграции WP-9, колонок ещё нет — фаза 2 обязана продолжать работать.
     */
    it('отдаёт манифест, даже если колонок снимка ещё нет в базе', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
      prisma.rightsIntake.update.mockRejectedValue(
        new Error("Unknown argument 'manifestStorageKey'"),
      );

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
    });
  });
});
