import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RightsContentHashService } from './rights-content-hash.service';
import { RightsFilesService } from './rights-files.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';

/**
 * WP-9.2 / WP-9.3 / WP-8.3: загрузка юридических файлов.
 *
 * Главное, что здесь проверяется, — не «сохранилось ли», а три правила пакета: замена
 * запрещена, загрузка файла источника пересчитывает свежесть клиренса, и наружу не уходит
 * ничего, чего в базе нет.
 */
const stored = {
  storageKey: 'report-pdf/2026/08/01/file.pdf',
  sha256: 'c'.repeat(64),
  sizeBytes: 1024,
  contentType: 'application/pdf',
  fileName: 'report.pdf',
};

const createPrismaStub = () => ({
  rightsReviewImport: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  sourceEdition: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  rightsEvidence: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
});

const createFilesStub = () => ({
  saveUpload: jest.fn().mockResolvedValue(stored),
  read: jest.fn(),
  getLimits: jest.fn().mockReturnValue({ maxSizeMb: 25 }),
});

const createHashStub = () => ({
  checkStalenessForRightsProfile: jest.fn().mockResolvedValue([]),
  rebaselineForRightsProfile: jest.fn().mockResolvedValue(undefined),
});

const upload = {
  buffer: Buffer.from('%PDF-1.4'),
  contentType: 'application/pdf',
  fileName: 'r.pdf',
};

describe('RightsFilesService', () => {
  let prisma: ReturnType<typeof createPrismaStub>;
  let files: ReturnType<typeof createFilesStub>;
  let hash: ReturnType<typeof createHashStub>;
  let service: RightsFilesService;

  beforeEach(() => {
    prisma = createPrismaStub();
    files = createFilesStub();
    hash = createHashStub();
    service = new RightsFilesService(
      prisma as unknown as PrismaService,
      files as unknown as RightsFileStorageService,
      hash as unknown as RightsContentHashService,
    );
  });

  describe('PDF-отчёт (WP-9.2)', () => {
    it('пишет ключ, сумму и сопровождение в импорт', async () => {
      prisma.rightsReviewImport.findUnique.mockResolvedValue({
        id: 'import-1',
        reportPdfStorageKey: null,
      });

      const result = await service.uploadReportPdf('import-1', upload, 'user-1');

      const data = prisma.rightsReviewImport.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.reportPdfStorageKey).toBe(stored.storageKey);
      expect(data.reportPdfSha256).toBe(stored.sha256);
      expect(data.reportPdfSizeBytes).toBe(stored.sizeBytes);
      expect(data.reportPdfUploadedByUserId).toBe('user-1');
      expect(result.sha256).toBe(stored.sha256);
    });

    it('запрещает замену: исправленный отчёт грузится новым импортом', async () => {
      prisma.rightsReviewImport.findUnique.mockResolvedValue({
        id: 'import-1',
        reportPdfStorageKey: 'report-pdf/old.pdf',
      });

      await expect(service.uploadReportPdf('import-1', upload, 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(files.saveUpload).not.toHaveBeenCalled();
      expect(prisma.rightsReviewImport.update).not.toHaveBeenCalled();
    });

    it('404 на неизвестном импорте — до записи в хранилище', async () => {
      prisma.rightsReviewImport.findUnique.mockResolvedValue(null);

      await expect(service.uploadReportPdf('nope', upload, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(files.saveUpload).not.toHaveBeenCalled();
    });

    it('скачивание отдаёт байты из хранилища', async () => {
      prisma.rightsReviewImport.findUnique.mockResolvedValue({
        id: 'import-1',
        reportPdfStorageKey: 'report-pdf/a.pdf',
        reportPdfFileName: 'report.pdf',
        reportPdfContentType: 'application/pdf',
      });
      files.read.mockResolvedValue(Buffer.from('bytes'));

      const download = await service.downloadReportPdf('import-1');

      expect(download.buffer).toEqual(Buffer.from('bytes'));
      expect(download.fileName).toBe('report.pdf');
    });

    it('404, если файл не загружен', async () => {
      prisma.rightsReviewImport.findUnique.mockResolvedValue({
        id: 'import-1',
        reportPdfStorageKey: null,
      });

      await expect(service.downloadReportPdf('import-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404, если ключ в базе есть, а объекта в хранилище нет', async () => {
      prisma.rightsReviewImport.findUnique.mockResolvedValue({
        id: 'import-1',
        reportPdfStorageKey: 'report-pdf/a.pdf',
        reportPdfFileName: null,
        reportPdfContentType: null,
      });
      files.read.mockResolvedValue(null);

      await expect(service.downloadReportPdf('import-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('файл источника (WP-8.3)', () => {
    beforeEach(() => {
      prisma.sourceEdition.findUnique.mockResolvedValue({
        id: 'se-1',
        sourceFileStorageKey: null,
        sourceFileSha256: null,
      });
    });

    /**
     * WP-D.2: суммы не было вовсе — файл прикладывают к уже снятому клиренсу, а не подменяют
     * издание. Baseline переснимается, клиренс не аннулируется.
     */
    it('первое появление суммы переснимает baseline, а не роняет клиренс в STALE', async () => {
      await service.uploadSourceFile('profile-1', upload, 'user-1');

      expect(hash.rebaselineForRightsProfile).toHaveBeenCalledWith(
        'profile-1',
        'SOURCE_EDITION_CHANGED',
        'SOURCE_FILE_FIRST_UPLOAD',
        expect.any(String),
        'user-1',
      );
      expect(hash.checkStalenessForRightsProfile).not.toHaveBeenCalled();
    });

    /**
     * Обратная сторона: сумму мог проставить отчёт агента. Тогда загруженный файл заменяет
     * известное издание — это по-прежнему `SOURCE_EDITION_CHANGED` со всеми последствиями.
     */
    it('замена уже известной суммы по-прежнему пересчитывает свежесть клиренса', async () => {
      prisma.sourceEdition.findUnique.mockResolvedValue({
        id: 'se-1',
        sourceFileStorageKey: null,
        sourceFileSha256: 'a'.repeat(64),
      });

      await service.uploadSourceFile('profile-1', upload, 'user-1');

      expect(hash.checkStalenessForRightsProfile).toHaveBeenCalledWith(
        'profile-1',
        'SOURCE_EDITION_CHANGED',
        'user-1',
      );
      expect(hash.rebaselineForRightsProfile).not.toHaveBeenCalled();
    });

    it('пишет сумму в исходное издание', async () => {
      await service.uploadSourceFile('profile-1', upload, 'user-1');

      const data = prisma.sourceEdition.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.sourceFileSha256).toBe(stored.sha256);
      expect(data.sourceFileStorageKey).toBe(stored.storageKey);
    });

    it('запрещает замену: она обнулила бы клиренс, снятый с прежнего файла', async () => {
      prisma.sourceEdition.findUnique.mockResolvedValue({
        id: 'se-1',
        sourceFileStorageKey: 'source-file/old.epub',
      });

      await expect(service.uploadSourceFile('profile-1', upload, null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(hash.checkStalenessForRightsProfile).not.toHaveBeenCalled();
    });

    it('404, если у профиля нет исходного издания', async () => {
      prisma.sourceEdition.findUnique.mockResolvedValue(null);

      await expect(service.uploadSourceFile('profile-1', upload, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /**
   * WP-D.2 по реальному конвейеру: загрузка идёт через настоящий `RightsContentHashService`,
   * а не через заглушку. Только так видно, что послабление применяется к каждой версии
   * профиля по отдельности — по состоянию её окна наполнения, а не оптом.
   */
  describe('файл источника через реальный конвейер (WP-D.2)', () => {
    const createHashPrismaStub = () => ({
      bookVersion: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      rightsReview: { update: jest.fn().mockResolvedValue({}) },
      rightsProfile: { update: jest.fn().mockResolvedValue({}) },
      rightsContentHashEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(),
    });

    let hashPrisma: ReturnType<typeof createHashPrismaStub>;
    let contentHash: RightsContentHashService;

    const eventReasonCodes = (): unknown[] =>
      hashPrisma.rightsContentHashEvent.create.mock.calls.map(
        (call) => (call[0] as { data: { reasonCode?: unknown } }).data.reasonCode,
      );

    beforeEach(() => {
      hashPrisma = createHashPrismaStub();
      hashPrisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
        cb(hashPrisma),
      );
      contentHash = new RightsContentHashService(hashPrisma as unknown as PrismaService);
      jest.spyOn(contentHash, 'computeVersionHash').mockResolvedValue({
        versionId: 'version-1',
        rightsProfileId: 'profile-1',
        approvedRightsReviewId: 'review-1',
        hash: 'hash-with-source-file',
        algorithmVersion: 'RIGHTS_CONTENT_HASH_V4',
        calculatedAt: new Date().toISOString(),
        input: {},
      });
      service = new RightsFilesService(
        prisma as unknown as PrismaService,
        files as unknown as RightsFileStorageService,
        contentHash,
      );
      prisma.sourceEdition.findUnique.mockResolvedValue({
        id: 'se-1',
        sourceFileStorageKey: null,
        sourceFileSha256: null,
      });
    });

    const versionRecord = (overrides: Record<string, unknown>) => ({
      id: 'version-1',
      rightsContentHash: 'baseline-hash',
      rightsContentHashAlgorithmVersion: 'RIGHTS_CONTENT_HASH_V4',
      rightsRecheckRequired: false,
      rightsStaleReasonCode: null,
      rightsStaleReasonRu: null,
      rightsStaleDetectedAt: null,
      rightsProfileId: 'profile-1',
      approvedRightsReviewId: 'review-1',
      ...overrides,
    });

    /**
     * Обратная сторона послабления: у опубликованной версии окно закрыто публикацией,
     * слепок зафиксирован — первая загрузка файла источника обязана уводить клиренс в `STALE`.
     */
    it('первая загрузка на опубликованной версии по-прежнему даёт STALE', async () => {
      const published = versionRecord({
        status: 'published',
        publishedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      hashPrisma.bookVersion.findMany.mockResolvedValueOnce([published]).mockResolvedValue([]);
      hashPrisma.bookVersion.findUnique.mockResolvedValue(published);

      await service.uploadSourceFile('profile-1', upload, 'user-1');

      expect(hashPrisma.rightsReview.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
      );
      expect(hashPrisma.rightsProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }),
      );
      expect(eventReasonCodes()).toContain('SOURCE_EDITION_CHANGED');
      expect(eventReasonCodes()).not.toContain('SOURCE_FILE_FIRST_UPLOAD');
    });

    /** Смягчение живо: у черновика с открытым окном baseline переснимается, клиренс цел. */
    it('первая загрузка в черновике с открытым окном переснимает baseline', async () => {
      const draft = versionRecord({ status: 'draft', publishedAt: null });
      hashPrisma.bookVersion.findMany.mockResolvedValueOnce([draft]).mockResolvedValue([]);
      hashPrisma.bookVersion.findUnique.mockResolvedValue(draft);
      hashPrisma.rightsContentHashEvent.findFirst.mockImplementation(
        (args: { where: { reasonCode: string } }) =>
          Promise.resolve(
            args.where.reasonCode === 'DRAFT_FILL_WINDOW_OPENED' ? { id: 'opened-event' } : null,
          ),
      );

      await service.uploadSourceFile('profile-1', upload, 'user-1');

      expect(hashPrisma.rightsReview.update).not.toHaveBeenCalled();
      expect(hashPrisma.rightsProfile.update).not.toHaveBeenCalled();
      expect(eventReasonCodes()).toContain('SOURCE_FILE_FIRST_UPLOAD');
      expect(hashPrisma.bookVersion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rightsContentHash: 'hash-with-source-file' }),
        }),
      );
    });
  });

  describe('архивная копия доказательства (WP-9.3)', () => {
    it('помечает доказательство архивированным и запоминает, кто это сделал', async () => {
      prisma.rightsEvidence.findUnique.mockResolvedValue({ id: 'ev-1', storageKey: null });

      await service.uploadEvidenceArchiveCopy('ev-1', upload, 'user-1');

      const data = prisma.rightsEvidence.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.isArchivedCopy).toBe(true);
      expect(data.fileSha256).toBe(stored.sha256);
      expect(data.archivedByUserId).toBe('user-1');
    });

    it('запрещает замену: копия — юридический след, её заводят заново новым доказательством', async () => {
      prisma.rightsEvidence.findUnique.mockResolvedValue({
        id: 'ev-1',
        storageKey: 'evidence/old.pdf',
      });

      await expect(service.uploadEvidenceArchiveCopy('ev-1', upload, null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('замена доказательства (WP-9.3)', () => {
    it('снимает isCurrent и указывает преемника', async () => {
      prisma.rightsEvidence.findUnique
        .mockResolvedValueOnce({ id: 'ev-1', rightsProfileId: 'p-1', supersededById: null })
        .mockResolvedValueOnce({ id: 'ev-2', rightsProfileId: 'p-1' });

      const result = await service.supersedeEvidence('ev-1', 'ev-2');

      const data = prisma.rightsEvidence.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.isCurrent).toBe(false);
      expect(data.supersededById).toBe('ev-2');
      expect(result.supersededById).toBe('ev-2');
    });

    it('не даёт доказательству заменить само себя', async () => {
      await expect(service.supersedeEvidence('ev-1', 'ev-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.rightsEvidence.findUnique).not.toHaveBeenCalled();
    });

    it('не даёт заменить доказательство чужого профиля', async () => {
      prisma.rightsEvidence.findUnique
        .mockResolvedValueOnce({ id: 'ev-1', rightsProfileId: 'p-1', supersededById: null })
        .mockResolvedValueOnce({ id: 'ev-2', rightsProfileId: 'p-2' });

      await expect(service.supersedeEvidence('ev-1', 'ev-2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('не даёт заменить уже заменённое', async () => {
      prisma.rightsEvidence.findUnique
        .mockResolvedValueOnce({ id: 'ev-1', rightsProfileId: 'p-1', supersededById: 'ev-0' })
        .mockResolvedValueOnce({ id: 'ev-2', rightsProfileId: 'p-1' });

      await expect(service.supersedeEvidence('ev-1', 'ev-2')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
