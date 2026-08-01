import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RightsFilesService } from './rights-files.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RightsContentHashService } from './rights-content-hash.service';
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
      });
    });

    it('пересчитывает свежесть клиренса: сумма файла входит в content hash', async () => {
      await service.uploadSourceFile('profile-1', upload, 'user-1');

      expect(hash.checkStalenessForRightsProfile).toHaveBeenCalledWith(
        'profile-1',
        'SOURCE_EDITION_CHANGED',
        'user-1',
      );
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
