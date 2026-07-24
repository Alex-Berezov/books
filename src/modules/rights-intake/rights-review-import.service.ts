import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RightsReviewImportValidator,
  type ValidationIssue,
} from './rights-review-import.validator';
import { stableJsonStringify, sha256Hex } from './rights-review-import-hash';
import { RIGHTS_REVIEW_IMPORT_SCHEMA_VERSION } from './rights-review-import.constants';
import type { CreateRightsReviewImportDto } from './dto/create-rights-review-import.dto';

@Injectable()
export class RightsReviewImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: RightsReviewImportValidator,
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

  async create(intakeId: string, dto: CreateRightsReviewImportDto, userId: string) {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${intakeId}' not found`);
    }

    const forbiddenStatuses = [
      'DRAFT',
      'ARCHIVED',
      'APPROVED',
      'REJECTED',
      'BOOK_CREATED',
      'HUMAN_REVIEW_REQUIRED',
    ];
    if (forbiddenStatuses.includes(intake.workflowStatus)) {
      throw new BadRequestException(
        'Review result can only be imported for READY_FOR_AGENT or REVIEW_IMPORTED intakes.',
      );
    }

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

    const importRecord = (await (this.prisma as unknown as Record<string, unknown>)[
      '$transaction'
    ]) as (
      fn: (tx: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>;

    type TxClient = {
      rightsReviewImport: {
        updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      rightsIntake: {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    };

    const result = await importRecord(async (tx: unknown) => {
      const t = tx as TxClient;

      await t.rightsReviewImport.updateMany({
        where: { rightsIntakeId: intakeId, isCurrent: true },
        data: {
          isCurrent: false,
          importStatus: 'SUPERSEDED',
          supersededAt: new Date(),
        },
      });

      const created = await t.rightsReviewImport.create({
        data: {
          ...baseData,
          importStatus: 'VALIDATED',
          isCurrent: true,
          validationWarnings: warnings.length > 0 ? (warnings as unknown as JSON) : undefined,
        },
      });

      await t.rightsIntake.update({
        where: { id: intakeId },
        data: { workflowStatus: 'REVIEW_IMPORTED' },
      });

      return created;
    });

    return result;
  }

  async listByIntake(intakeId: string, query: { page?: number; limit?: number; status?: string }) {
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
          importedByUserId: true,
          supersededAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const mapped = items.map((item) => ({
      ...item,
      validationErrorsCount: 0,
      validationWarningsCount: 0,
      supersededAt: item.supersededAt ? new Date(item.supersededAt as string).toISOString() : null,
      createdAt: new Date(item.createdAt as string).toISOString(),
      updatedAt: new Date(item.updatedAt as string).toISOString(),
    }));

    return {
      items: mapped,
      total,
      page,
      limit,
    };
  }

  async getById(importId: string) {
    const importRecord = await this.ri.findUnique({ where: { id: importId } });
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
