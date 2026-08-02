import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RightsReviewImportValidator,
  type ValidationIssue,
} from './rights-review-import.validator';
import { stableJsonStringify, sha256Hex } from './rights-review-import-hash';
import { REVIEW_IMPORTABLE_INTAKE_STATUSES } from './rights-intake.constants';
import { RIGHTS_REVIEW_IMPORT_SCHEMA_VERSION } from './rights-review-import.constants';
import { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';
import type { CreateRightsReviewImportDto } from './dto/create-rights-review-import.dto';

@Injectable()
export class RightsReviewImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: RightsReviewImportValidator,
    private readonly files: RightsFileStorageService,
  ) {}

  private get ri() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReviewImport'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      count: (args: Record<string, unknown>) => Promise<number>;
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
    };
  }

  /**
   * @param userId id of the human importing the report, or `null` when the report
   *   arrived through the Phase 17 agent API (no human involved).
   */
  async create(intakeId: string, dto: CreateRightsReviewImportDto, userId: string | null) {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${intakeId}' not found`);
    }

    // WP-10.3 (R4-04): белый список вместо чёрного — см. `REVIEW_IMPORTABLE_INTAKE_STATUSES`.
    if (!REVIEW_IMPORTABLE_INTAKE_STATUSES.includes(intake.workflowStatus)) {
      throw new BadRequestException(
        `Review result can only be imported for ${REVIEW_IMPORTABLE_INTAKE_STATUSES.join(', ')} intakes.`,
      );
    }

    // WP-9.1: манифест, отданный агенту. Колонки добавлены этим же пакетом, поэтому читаются
    // кастом (ADR-011): сгенерированный клиент про них узнает только после `prisma generate`.
    const intakeRecord = intake as unknown as Record<string, unknown>;
    const intakeManifest = {
      storageKey: (intakeRecord['manifestStorageKey'] as string | undefined) ?? null,
      sha256: (intakeRecord['manifestSha256'] as string | undefined) ?? null,
      version: (intakeRecord['manifestVersion'] as string | undefined) ?? null,
    };

    const reportJson = dto.reportJson;
    const targetLanguages = intake.targetLanguages as string[];
    const targetCountryCodes = intake.targetCountryCodes as string[];

    const { errors, warnings } = this.validator.validate(
      reportJson,
      intakeId,
      targetLanguages,
      targetCountryCodes,
    );

    const reportJsonString = stableJsonStringify(reportJson);
    const reportJsonSha256 = sha256Hex(reportJsonString);
    const reportMarkdownSha256 = dto.reportMarkdown ? sha256Hex(dto.reportMarkdown) : null;
    const rawAgentOutputSha256 = dto.rawAgentOutput ? sha256Hex(dto.rawAgentOutput) : null;

    // WP-9.1 (essence §15): архивные копии текстовых артефактов отчёта в приватном хранилище.
    // Источником истины остаётся `reportJson` в БД — ключи нужны, чтобы юридический пакет
    // выгружался целиком. Best-effort: недоступность хранилища не отменяет импорт, иначе
    // архивирование стало бы новым способом уронить единственный рабочий путь приёма отчёта.
    const [archivedJson, archivedMarkdown, archivedRaw] = await Promise.all([
      this.files.trySaveText(
        'report-json',
        reportJsonString,
        'application/json',
        `rights-report-${intakeId}.json`,
      ),
      dto.reportMarkdown
        ? this.files.trySaveText(
            'report-markdown',
            dto.reportMarkdown,
            'text/markdown',
            `rights-report-${intakeId}.md`,
          )
        : Promise.resolve(null),
      dto.rawAgentOutput
        ? this.files.trySaveText(
            'raw-agent-output',
            dto.rawAgentOutput,
            'text/plain',
            `rights-raw-agent-output-${intakeId}.txt`,
          )
        : Promise.resolve(null),
    ]);

    const baseData = {
      rightsIntakeId: intakeId,
      schemaVersion: RIGHTS_REVIEW_IMPORT_SCHEMA_VERSION,
      reportJson: reportJson as unknown as JSON,
      reportMarkdown: dto.reportMarkdown ?? null,
      rawAgentOutput: dto.rawAgentOutput ?? null,
      sourceFileName: dto.sourceFileName ?? null,
      reportJsonSha256,
      reportMarkdownSha256,
      rawAgentOutputSha256,
      reportJsonStorageKey: archivedJson?.storageKey ?? null,
      reportMarkdownStorageKey: archivedMarkdown?.storageKey ?? null,
      rawAgentOutputStorageKey: archivedRaw?.storageKey ?? null,
      // WP-9.1: снимок задания, под которое написан отчёт. Копируется из интейка в момент
      // импорта, поэтому переиздание манифеста задним числом не меняет того, что было у уже
      // принятого отчёта. `promptVersion` — версия того же манифеста.
      inputManifestStorageKey: intakeManifest.storageKey,
      inputManifestSha256: intakeManifest.sha256,
      inputManifestVersion: intakeManifest.version,
      promptVersion: intakeManifest.version,
      agentModel: dto.agentModel ?? null,
      importedByUserId: userId,
    };

    const hasErrors = errors.length > 0;

    if (hasErrors) {
      const importRecord = await this.ri.create({
        data: {
          ...baseData,
          importStatus: 'VALIDATION_FAILED',
          isCurrent: false,
          validationErrors: errors as unknown as JSON,
          validationWarnings: warnings.length > 0 ? (warnings as unknown as JSON) : undefined,
        },
      });
      return importRecord;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const riTx = t['rightsReviewImport'] as {
        updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const intakeTx = t['rightsIntake'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      await riTx.updateMany({
        where: { rightsIntakeId: intakeId, isCurrent: true },
        data: {
          isCurrent: false,
          importStatus: 'SUPERSEDED',
          supersededAt: new Date(),
        },
      });

      const created = await riTx.create({
        data: {
          ...baseData,
          importStatus: 'VALIDATED',
          isCurrent: true,
          validationWarnings: warnings.length > 0 ? (warnings as unknown as JSON) : undefined,
        },
      });

      await intakeTx.update({
        where: { id: intakeId },
        data: { workflowStatus: 'REVIEW_IMPORTED' },
      });

      return created;
    });

    return result;
  }

  async listByIntake(intakeId: string, query: { page?: number; limit?: number; status?: string }) {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${intakeId}' not found`);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { rightsIntakeId: intakeId };
    if (query.status) {
      where['importStatus'] = query.status;
    }

    const [total, items] = await Promise.all([
      this.ri.count({ where }),
      this.ri.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          rightsIntakeId: true,
          schemaVersion: true,
          importStatus: true,
          isCurrent: true,
          sourceFileName: true,
          validationErrors: true,
          validationWarnings: true,
          importedByUserId: true,
          supersededAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const mapped = items.map((item) => {
      const errs = item['validationErrors'] as ValidationIssue[] | null;
      const warns = item['validationWarnings'] as ValidationIssue[] | null;
      return {
        id: item['id'],
        rightsIntakeId: item['rightsIntakeId'],
        schemaVersion: item['schemaVersion'],
        importStatus: item['importStatus'],
        isCurrent: item['isCurrent'],
        sourceFileName: item['sourceFileName'],
        validationErrorsCount: errs?.length ?? 0,
        validationWarningsCount: warns?.length ?? 0,
        importedByUserId: item['importedByUserId'],
        supersededAt: item['supersededAt']
          ? new Date(item['supersededAt'] as string).toISOString()
          : null,
        createdAt: new Date(item['createdAt'] as string).toISOString(),
        updatedAt: new Date(item['updatedAt'] as string).toISOString(),
      };
    });

    return {
      items: mapped,
      total,
      page,
      limit,
    };
  }

  async getById(importId: string) {
    const importRecord = await this.ri.findUnique({
      where: { id: importId },
    });
    if (!importRecord) {
      throw new NotFoundException(`Review import with ID '${importId}' not found`);
    }

    const validationErrors = importRecord['validationErrors'] as ValidationIssue[] | null;
    const validationWarnings = importRecord['validationWarnings'] as ValidationIssue[] | null;

    return {
      id: importRecord['id'],
      rightsIntakeId: importRecord['rightsIntakeId'],
      schemaVersion: importRecord['schemaVersion'],
      importStatus: importRecord['importStatus'],
      isCurrent: importRecord['isCurrent'],
      reportJson: importRecord['reportJson'],
      reportMarkdown: importRecord['reportMarkdown'],
      rawAgentOutput: importRecord['rawAgentOutput'],
      sourceFileName: importRecord['sourceFileName'],
      reportJsonSha256: importRecord['reportJsonSha256'],
      reportMarkdownSha256: importRecord['reportMarkdownSha256'],
      rawAgentOutputSha256: importRecord['rawAgentOutputSha256'],
      // WP-9.2: сам ключ хранилища наружу не отдаётся, наличие файла — флагом.
      hasReportPdf: Boolean(importRecord['reportPdfStorageKey']),
      reportPdfSha256: (importRecord['reportPdfSha256'] as string) ?? null,
      reportPdfFileName: (importRecord['reportPdfFileName'] as string) ?? null,
      reportPdfContentType: (importRecord['reportPdfContentType'] as string) ?? null,
      reportPdfSizeBytes: (importRecord['reportPdfSizeBytes'] as number) ?? null,
      reportPdfUploadedAt: importRecord['reportPdfUploadedAt']
        ? new Date(importRecord['reportPdfUploadedAt'] as string).toISOString()
        : null,
      inputManifestSha256: (importRecord['inputManifestSha256'] as string) ?? null,
      inputManifestVersion: (importRecord['inputManifestVersion'] as string) ?? null,
      promptVersion: (importRecord['promptVersion'] as string) ?? null,
      agentModel: (importRecord['agentModel'] as string) ?? null,
      validationErrors,
      validationWarnings,
      importedByUserId: importRecord['importedByUserId'],
      supersededAt: importRecord['supersededAt']
        ? new Date(importRecord['supersededAt'] as string).toISOString()
        : null,
      createdAt: importRecord['createdAt']
        ? new Date(importRecord['createdAt'] as string).toISOString()
        : '',
      updatedAt: importRecord['updatedAt']
        ? new Date(importRecord['updatedAt'] as string).toISOString()
        : '',
    };
  }
}
