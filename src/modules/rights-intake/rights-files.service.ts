import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';
import type { RightsFileUpload } from '../../shared/rights-file-storage/rights-file-storage.types';
import { RightsContentHashService } from './rights-content-hash.service';

const fail: (code: string, messageRu: string) => never = (code, messageRu) => {
  throw new BadRequestException({ message: messageRu, code });
};

const failNotFound: (code: string, messageRu: string) => never = (code, messageRu) => {
  throw new NotFoundException({ message: messageRu, code });
};

/** Что отдаётся клиенту после загрузки и что показывает карточка файла. */
export interface RightsFileDescriptorDto {
  storageKey: string;
  sha256: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
}

/** Готовый к отдаче файл: контроллер оборачивает его в StreamableFile. */
export interface RightsFileDownload {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}

type Delegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/**
 * WP-9.2 / WP-9.3 / WP-8.3: загрузка и выдача юридических файлов системы прав.
 *
 * Три правила, общие для всех трёх путей:
 *
 * 1. **Контрольную сумму считает сервер** (правило WP-8.2): по ней сверяется юридический
 *    артефакт, поэтому её источник не может быть на стороне клиента.
 * 2. **Замена запрещена.** Уже загруженный файл нельзя перезаписать: объект в хранилище мы не
 *    удаляем (ADR-009), а перезапись ключа в БД потеряла бы указатель на предыдущий. Нужен
 *    другой отчёт — создаётся новый импорт (импорты и так вытесняют друг друга); нужно другое
 *    доказательство — заводится новое и помечается заменяющим через `supersededById`.
 * 3. **Публичный URL не вычисляется и не отдаётся.** Наружу уходит только дескриптор с ключом
 *    и суммой; сам файл скачивается этим же сервисом под ролями Admin/ContentManager.
 */
@Injectable()
export class RightsFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: RightsFileStorageService,
    private readonly contentHash: RightsContentHashService,
  ) {}

  private delegate(model: string): Delegate {
    return (this.prisma as unknown as Record<string, unknown>)[model] as Delegate;
  }

  getLimits() {
    return this.files.getLimits();
  }

  // ---------------------------------------------------------------- report PDF (WP-9.2)

  async uploadReportPdf(
    importId: string,
    upload: RightsFileUpload,
    userId: string | null,
  ): Promise<RightsFileDescriptorDto> {
    const record = await this.delegate('rightsReviewImport').findUnique({
      where: { id: importId },
      select: { id: true, reportPdfStorageKey: true },
    });
    if (!record) {
      failNotFound('REVIEW_IMPORT_NOT_FOUND', `Импорт отчёта '${importId}' не найден.`);
    }
    if (record.reportPdfStorageKey) {
      fail(
        'REPORT_PDF_ALREADY_UPLOADED',
        'PDF-отчёт уже загружен. Замена запрещена: загрузите исправленный отчёт новым импортом.',
      );
    }

    const stored = await this.files.saveUpload('report-pdf', upload);
    const uploadedAt = new Date();

    await this.delegate('rightsReviewImport').update({
      where: { id: importId },
      data: {
        reportPdfStorageKey: stored.storageKey,
        reportPdfSha256: stored.sha256,
        reportPdfFileName: stored.fileName,
        reportPdfContentType: stored.contentType,
        reportPdfSizeBytes: stored.sizeBytes,
        reportPdfUploadedAt: uploadedAt,
        reportPdfUploadedByUserId: userId,
      },
    });

    return toDescriptor(stored, uploadedAt);
  }

  async downloadReportPdf(importId: string): Promise<RightsFileDownload> {
    const record = await this.delegate('rightsReviewImport').findUnique({
      where: { id: importId },
      select: {
        id: true,
        reportPdfStorageKey: true,
        reportPdfFileName: true,
        reportPdfContentType: true,
      },
    });
    if (!record) {
      failNotFound('REVIEW_IMPORT_NOT_FOUND', `Импорт отчёта '${importId}' не найден.`);
    }
    return this.readOrFail(
      record.reportPdfStorageKey as string | null,
      (record.reportPdfFileName as string | null) ?? `rights-report-${importId}.pdf`,
      (record.reportPdfContentType as string | null) ?? 'application/pdf',
      'REPORT_PDF_NOT_UPLOADED',
      'PDF-отчёт для этого импорта не загружен.',
    );
  }

  // ------------------------------------------------------- файл источника (WP-8.3 / R3-05)

  async uploadSourceFile(
    profileId: string,
    upload: RightsFileUpload,
    userId: string | null,
  ): Promise<RightsFileDescriptorDto> {
    const sourceEdition = await this.delegate('sourceEdition').findUnique({
      where: { rightsProfileId: profileId },
      select: { id: true, sourceFileStorageKey: true },
    });
    if (!sourceEdition) {
      failNotFound(
        'SOURCE_EDITION_NOT_FOUND',
        `У профиля прав '${profileId}' нет исходного издания.`,
      );
    }
    if (sourceEdition.sourceFileStorageKey) {
      fail(
        'SOURCE_FILE_ALREADY_UPLOADED',
        'Файл источника уже загружен. Замена запрещена: она сделала бы недействительным клиренс, снятый с прежнего файла.',
      );
    }

    const stored = await this.files.saveUpload('source-file', upload);
    const uploadedAt = new Date();

    await this.delegate('sourceEdition').update({
      where: { id: sourceEdition.id as string },
      data: {
        sourceFileStorageKey: stored.storageKey,
        sourceFileSha256: stored.sha256,
        sourceFileName: stored.fileName,
        sourceFileContentType: stored.contentType,
        sourceFileSizeBytes: stored.sizeBytes,
        sourceFileUploadedAt: uploadedAt,
        sourceFileUploadedByUserId: userId,
      },
    });

    // WP-8.3: сумма файла источника входит в content hash — появление файла меняет вход
    // и обязано быть замечено клиренсом ровно так же, как смена переводчика (WP-8.1).
    // Триггер `SOURCE_EDITION_CHANGED` уже есть в enum'е, поэтому пары миграций не нужно.
    await this.contentHash.checkStalenessForRightsProfile(
      profileId,
      'SOURCE_EDITION_CHANGED',
      userId,
    );

    return toDescriptor(stored, uploadedAt);
  }

  async downloadSourceFile(profileId: string): Promise<RightsFileDownload> {
    const sourceEdition = await this.delegate('sourceEdition').findUnique({
      where: { rightsProfileId: profileId },
      select: {
        id: true,
        sourceFileStorageKey: true,
        sourceFileName: true,
        sourceFileContentType: true,
      },
    });
    if (!sourceEdition) {
      failNotFound(
        'SOURCE_EDITION_NOT_FOUND',
        `У профиля прав '${profileId}' нет исходного издания.`,
      );
    }
    return this.readOrFail(
      sourceEdition.sourceFileStorageKey as string | null,
      (sourceEdition.sourceFileName as string | null) ?? `source-${profileId}.bin`,
      (sourceEdition.sourceFileContentType as string | null) ?? 'application/octet-stream',
      'SOURCE_FILE_NOT_UPLOADED',
      'Файл источника не загружен.',
    );
  }

  // ------------------------------------------------- архивная копия доказательства (WP-9.3)

  async uploadEvidenceArchiveCopy(
    evidenceId: string,
    upload: RightsFileUpload,
    userId: string | null,
  ): Promise<RightsFileDescriptorDto> {
    const evidence = await this.delegate('rightsEvidence').findUnique({
      where: { id: evidenceId },
      select: { id: true, storageKey: true },
    });
    if (!evidence) {
      failNotFound('EVIDENCE_NOT_FOUND', `Доказательство '${evidenceId}' не найдено.`);
    }
    if (evidence.storageKey) {
      fail(
        'EVIDENCE_ARCHIVE_ALREADY_UPLOADED',
        'Архивная копия уже загружена. Замена запрещена: заведите новое доказательство и пометьте им прежнее как заменённое.',
      );
    }

    const stored = await this.files.saveUpload('evidence', upload);
    const archivedAt = new Date();

    await this.delegate('rightsEvidence').update({
      where: { id: evidenceId },
      data: {
        storageKey: stored.storageKey,
        fileSha256: stored.sha256,
        fileName: stored.fileName,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        isArchivedCopy: true,
        archivedAt,
        archivedByUserId: userId,
      },
    });

    return toDescriptor(stored, archivedAt);
  }

  async downloadEvidenceArchiveCopy(evidenceId: string): Promise<RightsFileDownload> {
    const evidence = await this.delegate('rightsEvidence').findUnique({
      where: { id: evidenceId },
      select: { id: true, storageKey: true, fileName: true, contentType: true },
    });
    if (!evidence) {
      failNotFound('EVIDENCE_NOT_FOUND', `Доказательство '${evidenceId}' не найдено.`);
    }
    return this.readOrFail(
      evidence.storageKey as string | null,
      (evidence.fileName as string | null) ?? `evidence-${evidenceId}.bin`,
      (evidence.contentType as string | null) ?? 'application/octet-stream',
      'EVIDENCE_ARCHIVE_NOT_UPLOADED',
      'Архивная копия доказательства не загружена.',
    );
  }

  /**
   * Помечает доказательство заменённым другим. Удалить его нельзя (ADR-009), поэтому
   * единственный способ сказать «оно больше не действует» — указать преемника.
   */
  async supersedeEvidence(evidenceId: string, supersededById: string) {
    if (evidenceId === supersededById) {
      fail('EVIDENCE_SELF_SUPERSESSION', 'Доказательство не может заменять само себя.');
    }

    const [evidence, successor] = await Promise.all([
      this.delegate('rightsEvidence').findUnique({
        where: { id: evidenceId },
        select: { id: true, rightsProfileId: true, supersededById: true },
      }),
      this.delegate('rightsEvidence').findUnique({
        where: { id: supersededById },
        select: { id: true, rightsProfileId: true },
      }),
    ]);

    if (!evidence) {
      failNotFound('EVIDENCE_NOT_FOUND', `Доказательство '${evidenceId}' не найдено.`);
    }
    if (!successor) {
      failNotFound('EVIDENCE_NOT_FOUND', `Доказательство '${supersededById}' не найдено.`);
    }
    if (evidence.rightsProfileId !== successor.rightsProfileId) {
      fail(
        'EVIDENCE_PROFILE_MISMATCH',
        'Заменяющее доказательство должно принадлежать тому же профилю прав.',
      );
    }
    if (evidence.supersededById) {
      fail('EVIDENCE_ALREADY_SUPERSEDED', 'Это доказательство уже помечено заменённым.');
    }

    await this.delegate('rightsEvidence').update({
      where: { id: evidenceId },
      data: { isCurrent: false, supersededById },
    });

    return { id: evidenceId, isCurrent: false, supersededById };
  }

  // ------------------------------------------------------------------------------ helpers

  private async readOrFail(
    storageKey: string | null,
    fileName: string,
    contentType: string,
    missingCode: string,
    missingMessage: string,
  ): Promise<RightsFileDownload> {
    if (!storageKey) {
      failNotFound(missingCode, missingMessage);
    }
    const buffer = await this.files.read(storageKey);
    if (!buffer) {
      failNotFound(
        'RIGHTS_FILE_OBJECT_MISSING',
        'Файл числится в базе, но отсутствует в хранилище. Обратитесь к администратору.',
      );
    }
    return { buffer, fileName, contentType };
  }
}

function toDescriptor(
  stored: {
    storageKey: string;
    sha256: string;
    fileName: string | null;
    contentType: string;
    sizeBytes: number;
  },
  at: Date,
): RightsFileDescriptorDto {
  return {
    storageKey: stored.storageKey,
    sha256: stored.sha256,
    fileName: stored.fileName,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    uploadedAt: at.toISOString(),
  };
}
