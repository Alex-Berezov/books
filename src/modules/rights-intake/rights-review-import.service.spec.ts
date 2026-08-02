import { RightsReviewImportService } from './rights-review-import.service';
import { RightsReviewImportValidator } from './rights-review-import.validator';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';

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

/**
 * WP-9.1: импорт архивирует текстовые артефакты отчёта в приватное хранилище прав.
 * Запись best-effort, поэтому заглушка возвращает готовые дескрипторы, а отдельный тест
 * проверяет, что отказ хранилища импорт не роняет.
 */
type ArchivedArtefact = {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  fileName: string | null;
} | null;

const createFilesStub = () => ({
  trySaveText: jest.fn<Promise<ArchivedArtefact>, [string]>((kind: string) =>
    Promise.resolve({
      storageKey: `${kind}/2026/08/01/artefact.bin`,
      sha256: 'b'.repeat(64),
      sizeBytes: 10,
      contentType: 'application/octet-stream',
      fileName: null,
    }),
  ),
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
  let files: ReturnType<typeof createFilesStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    validator = new RightsReviewImportValidator();
    files = createFilesStub();
    service = new RightsReviewImportService(
      prisma as unknown as PrismaService,
      validator,
      files as unknown as RightsFileStorageService,
    );
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

  // WP-10.3 (R4-04): фильтр статусов фазы 3 был чёрным списком и не знал о статусе фазы 19.
  // Импорт молча вытаскивал интейк из юридической проверки в REVIEW_IMPORTED, после чего
  // условные апдейты фазы 19 (`workflowStatus: 'LAWYER_REVIEW_REQUIRED'`) не находили строку.
  it('import forbidden for LAWYER_REVIEW_REQUIRED and does not move the intake', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(
      mockIntake({ workflowStatus: 'LAWYER_REVIEW_REQUIRED' }),
    );
    prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
    prisma.rightsReviewImport.create.mockResolvedValue({ id: 'import-1' });
    prisma.rightsIntake.update.mockResolvedValue({});

    await expect(service.create('intake-1', createDto(), 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
    expect(prisma.rightsReviewImport.create).not.toHaveBeenCalled();
  });

  it('import allowed for HUMAN_REVIEW_REQUIRED (re-import)', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(
      mockIntake({ workflowStatus: 'HUMAN_REVIEW_REQUIRED' }),
    );
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

  it('import allowed for APPROVED (re-import)', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake({ workflowStatus: 'APPROVED' }));
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

  it('import allowed for REJECTED (re-import)', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake({ workflowStatus: 'REJECTED' }));
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

  /**
   * WP-9.1 (R4-02, essence §15). До этого пакета текстовые артефакты отчёта жили только как
   * `@db.Text`, а под каким заданием агент писал отчёт — не фиксировалось нигде.
   */
  describe('WP-9.1: архивные копии артефактов и снимок задания', () => {
    const setupValidImport = () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        mockIntake({
          manifestStorageKey: 'input-manifest/2026/08/01/m.json',
          manifestSha256: 'e'.repeat(64),
          manifestVersion: '1.1',
        }),
      );
      prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 0 });
      prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
      prisma.rightsReviewImport.create.mockResolvedValue({ id: 'import-1' });
      prisma.rightsIntake.update.mockResolvedValue({});
    };

    const createdData = () =>
      prisma.rightsReviewImport.create.mock.calls[0][0].data as Record<string, unknown>;

    it('архивирует JSON-отчёт и пишет его ключ', async () => {
      setupValidImport();

      await service.create('intake-1', createDto(), 'user-1');

      expect(files.trySaveText).toHaveBeenCalledWith(
        'report-json',
        expect.any(String),
        'application/json',
        expect.stringContaining('intake-1'),
      );
      expect(createdData().reportJsonStorageKey).toBe('report-json/2026/08/01/artefact.bin');
    });

    it('не архивирует markdown и сырой вывод, когда их не прислали', async () => {
      setupValidImport();

      await service.create('intake-1', createDto(), 'user-1');

      expect(createdData().reportMarkdownStorageKey).toBeNull();
      expect(createdData().rawAgentOutputStorageKey).toBeNull();
    });

    it('архивирует markdown и сырой вывод, когда они есть', async () => {
      setupValidImport();

      await service.create(
        'intake-1',
        createDto({ reportMarkdown: '# hello', rawAgentOutput: 'raw' }),
        'user-1',
      );

      expect(createdData().reportMarkdownStorageKey).toBe(
        'report-markdown/2026/08/01/artefact.bin',
      );
      expect(createdData().rawAgentOutputStorageKey).toBe(
        'raw-agent-output/2026/08/01/artefact.bin',
      );
    });

    it('копирует снимок манифеста интейка: под каким заданием сделан отчёт', async () => {
      setupValidImport();

      await service.create('intake-1', createDto(), 'user-1');

      expect(createdData().inputManifestStorageKey).toBe('input-manifest/2026/08/01/m.json');
      expect(createdData().inputManifestSha256).toBe('e'.repeat(64));
      expect(createdData().inputManifestVersion).toBe('1.1');
      expect(createdData().promptVersion).toBe('1.1');
    });

    it('обходится без снимка, если манифест ни разу не скачивали', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(mockIntake());
      prisma.rightsReviewImport.updateMany.mockResolvedValue({ count: 0 });
      prisma.$transaction.mockImplementation((fn: (tx: PrismaStub) => unknown) => fn(prisma));
      prisma.rightsReviewImport.create.mockResolvedValue({ id: 'import-1' });
      prisma.rightsIntake.update.mockResolvedValue({});

      await service.create('intake-1', createDto(), 'user-1');

      expect(createdData().inputManifestStorageKey).toBeNull();
      expect(createdData().promptVersion).toBeNull();
    });

    it('сохраняет самоидентификацию агента', async () => {
      setupValidImport();

      await service.create('intake-1', createDto({ agentModel: 'ChatGPT o3' }), 'user-1');

      expect(createdData().agentModel).toBe('ChatGPT o3');
    });

    it('отказ хранилища не отменяет импорт: ключи остаются пустыми', async () => {
      setupValidImport();
      files.trySaveText.mockResolvedValue(null);

      const result = await service.create('intake-1', createDto(), 'user-1');

      expect(result).toBeTruthy();
      expect(createdData().reportJsonStorageKey).toBeNull();
      expect(createdData().reportJsonSha256).toBeTruthy();
    });
  });
});
