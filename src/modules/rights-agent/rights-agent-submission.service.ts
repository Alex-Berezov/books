import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsMaterializationService } from '../rights-intake/rights-materialization.service';
import { sha256Hex, stableJsonStringify } from '../rights-intake/rights-review-import-hash';
import { RightsReviewImportService } from '../rights-intake/rights-review-import.service';
import {
  RIGHTS_REPORT_SCHEMA_VERSIONS,
  isSupportedReportSchemaVersion,
} from '../rights-intake/rights-review-schema.registry';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsNotificationsService } from './rights-notifications.service';
import {
  AGENT_ERROR_CODES,
  AGENT_ERROR_MESSAGES_RU,
  AGENT_REPORT_MAX_BYTES,
  AGENT_SUBMISSION_ALLOWED_INTAKE_STATUSES,
  type AgentErrorCode,
} from './rights-agent.constants';
import { agentError } from './rights-agent.errors';
import {
  RightsAgentSubmissionMaterialization,
  RightsAgentSubmissionStatus,
  RightsNotificationSeverity,
  RightsNotificationType,
  type AgentTokenRequestContext,
  type RightsAgentSubmissionDelegate,
  type RightsAgentSubmissionRecord,
} from './rights-agent-interface';
import type { ValidationIssue } from '../rights-intake/rights-review-import.validator';
import type { AgentSubmitReportDto } from './dto/agent-submit-report.dto';
import type { AgentSubmitResponseDto } from './dto/agent-submit-response.dto';
import type { ListAgentSubmissionsDto } from './dto/list-agent-submissions.dto';
import type {
  AgentSubmissionDto,
  AgentSubmissionListResponseDto,
} from './dto/agent-submission-response.dto';

export interface AgentSubmissionMeta {
  ip: string | null;
  userAgent: string | null;
}

interface ImportOutcome {
  id: string;
  importStatus: string;
  validationErrors: ValidationIssue[];
  validationWarnings: ValidationIssue[];
  reportJsonSha256: string | null;
}

@Injectable()
export class RightsAgentSubmissionService {
  private readonly logger = new Logger(RightsAgentSubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewImports: RightsReviewImportService,
    private readonly materialization: RightsMaterializationService,
    private readonly tokens: RightsAgentTokenService,
    private readonly notifications: RightsNotificationsService,
    private readonly config: ConfigService,
  ) {}

  private get submissionDelegate(): RightsAgentSubmissionDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsAgentSubmission'
    ] as RightsAgentSubmissionDelegate;
  }

  private get maxReportBytes(): number {
    const raw = Number(this.config.get('RIGHTS_AGENT_MAX_REPORT_BYTES'));
    return Number.isFinite(raw) && raw > 0 ? raw : AGENT_REPORT_MAX_BYTES;
  }

  /**
   * Accepts one agent report.
   *
   * `RightsReviewImportService.create` and `materializeFromImport` each own their transaction,
   * so steps 6–9 are deliberately NOT wrapped in one outer transaction: the order is chosen so
   * that a failure at any step still leaves a consistent `RightsAgentSubmission` row carrying
   * the diagnostics. A failed materialization does not roll back the import — the editor can
   * re-run it by hand from `RightsProfilePanel`.
   */
  async submit(
    context: AgentTokenRequestContext,
    dto: AgentSubmitReportDto,
    meta: AgentSubmissionMeta,
  ): Promise<AgentSubmitResponseDto> {
    // 1. The token binds the request to exactly one intake.
    if (dto.intakeId && dto.intakeId !== context.rightsIntakeId) {
      throw agentError(HttpStatus.FORBIDDEN, AGENT_ERROR_CODES.AGENT_TOKEN_INTAKE_MISMATCH);
    }
    const intakeId = context.rightsIntakeId;

    // 2. Intake must exist and be in a status that accepts submissions.
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.INTAKE_NOT_FOUND);
    }
    if (
      !(AGENT_SUBMISSION_ALLOWED_INTAKE_STATUSES as readonly string[]).includes(
        intake.workflowStatus,
      )
    ) {
      await this.reject(context, dto, meta, {
        code: AGENT_ERROR_CODES.INTAKE_NOT_ACCEPTING_SUBMISSIONS,
        status: HttpStatus.CONFLICT,
        details: { workflowStatus: intake.workflowStatus },
      });
    }

    // 3. Size guard, independent of the express body limit.
    const payloadSizeBytes = this.measurePayload(dto);
    if (payloadSizeBytes > this.maxReportBytes) {
      await this.reject(context, dto, meta, {
        code: AGENT_ERROR_CODES.REPORT_TOO_LARGE,
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        details: { payloadSizeBytes, maxBytes: this.maxReportBytes },
        payloadSizeBytes,
      });
    }

    // 4. Schema version must be supported globally and by this token.
    const declaredSchemaVersion =
      typeof dto.report['schemaVersion'] === 'string' ? dto.report['schemaVersion'] : null;
    const tokenAllows =
      context.allowedSchemaVersions === null ||
      (declaredSchemaVersion !== null &&
        context.allowedSchemaVersions.includes(declaredSchemaVersion));
    if (!isSupportedReportSchemaVersion(declaredSchemaVersion) || !tokenAllows) {
      await this.reject(context, dto, meta, {
        code: AGENT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
        status: HttpStatus.BAD_REQUEST,
        details: {
          declaredSchemaVersion,
          supportedSchemaVersions: [...RIGHTS_REPORT_SCHEMA_VERSIONS],
          tokenAllowedSchemaVersions: context.allowedSchemaVersions,
        },
        payloadSizeBytes,
        declaredSchemaVersion,
      });
    }

    // 5. Identical report already imported → reject without consuming a use.
    const reportJsonSha256 = sha256Hex(stableJsonStringify(dto.report));
    const duplicate = await this.findCurrentImportByHash(intakeId, reportJsonSha256);
    if (duplicate) {
      await this.tokens.registerFailure(context.tokenId, false);
      await this.reject(context, dto, meta, {
        code: AGENT_ERROR_CODES.DUPLICATE_SUBMISSION,
        status: HttpStatus.CONFLICT,
        details: { reportJsonSha256 },
        payloadSizeBytes,
        declaredSchemaVersion,
        reportJsonSha256,
      });
    }

    // 6. Journal the accepted request before any heavy work.
    const submission = await this.submissionDelegate.create({
      data: {
        rightsIntakeId: intakeId,
        uploadTokenId: context.tokenId,
        status: RightsAgentSubmissionStatus.RECEIVED,
        declaredSchemaVersion,
        reportJsonSha256,
        payloadSizeBytes,
        sourceFileName: dto.sourceFileName ?? null,
        agentName: dto.agentName ?? null,
        agentVersion: dto.agentVersion ?? null,
        submittedIp: meta.ip,
        submittedUserAgent: meta.userAgent,
      },
    });

    await this.tokens.touchUsage(context.tokenId, meta.ip, meta.userAgent);

    // 7. Reuse the exact same import path as the manual Phase 3 flow. userId is null:
    //    the import was not performed by a human.
    const importOutcome = await this.runImport(submission.id, intakeId, dto);

    // 8. Interpret the import result.
    const candidateTitle = intake.candidateTitle;
    if (importOutcome.importStatus !== 'VALIDATED') {
      return this.finishValidationFailed(
        submission,
        context,
        importOutcome,
        intakeId,
        candidateTitle,
        declaredSchemaVersion,
      );
    }

    await this.tokens.registerSuccess(context.tokenId);
    await this.notifications.create({
      type: RightsNotificationType.AGENT_REPORT_RECEIVED,
      severity: RightsNotificationSeverity.SUCCESS,
      titleRu: 'Получен отчёт агента',
      messageRu: `Внешний агент прислал отчёт по интейку «${candidateTitle}». Предупреждений: ${importOutcome.validationWarnings.length}.`,
      rightsIntakeId: intakeId,
      agentSubmissionId: submission.id,
      rightsReviewImportId: importOutcome.id,
      payload: { warningCount: importOutcome.validationWarnings.length },
    });

    // 9. Optional materialization into a draft profile + HUMAN_REVIEW_REQUIRED review.
    const materializationOutcome = await this.runMaterialization(
      context,
      submission.id,
      importOutcome.id,
      intakeId,
      candidateTitle,
    );

    const processedAt = new Date();
    const updated = await this.submissionDelegate.update({
      where: { id: submission.id },
      data: {
        status: RightsAgentSubmissionStatus.VALIDATED,
        rightsReviewImportId: importOutcome.id,
        validationErrorCount: 0,
        validationWarningCount: importOutcome.validationWarnings.length,
        materialization: materializationOutcome.materialization,
        materializationError: materializationOutcome.error,
        materializedProfileId: materializationOutcome.profileId,
        processedAt,
      },
    });

    return {
      submissionId: updated.id,
      status: 'VALIDATED',
      intakeId,
      schemaVersion: declaredSchemaVersion,
      reviewImportId: importOutcome.id,
      reportJsonSha256: importOutcome.reportJsonSha256,
      validationErrors: [],
      validationWarnings: importOutcome.validationWarnings,
      materialization: materializationOutcome.materialization,
      humanApprovalRequired: true,
      messageRu:
        'Отчёт принят и прошёл валидацию. Результат должен быть утверждён редактором Bibliaris.',
      receivedAt: processedAt.toISOString(),
    };
  }

  async listByIntake(
    intakeId: string,
    query: ListAgentSubmissionsDto,
  ): Promise<AgentSubmissionListResponseDto> {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.INTAKE_NOT_FOUND);
    }
    return this.query({ ...query, intakeId });
  }

  async listAll(query: ListAgentSubmissionsDto): Promise<AgentSubmissionListResponseDto> {
    return this.query(query);
  }

  async getById(submissionId: string): Promise<AgentSubmissionDto> {
    const submission = await this.submissionDelegate.findUnique({
      where: { id: submissionId },
      include: { uploadToken: { select: { tokenPrefix: true } } },
    });
    if (!submission) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.AGENT_SUBMISSION_NOT_FOUND);
    }
    return this.toDto(submission);
  }

  private async query(query: ListAgentSubmissionsDto): Promise<AgentSubmissionListResponseDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (query.intakeId) {
      where['rightsIntakeId'] = query.intakeId;
    }
    if (query.status) {
      where['status'] = query.status;
    }

    const [total, items] = await Promise.all([
      this.submissionDelegate.count({ where }),
      this.submissionDelegate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { uploadToken: { select: { tokenPrefix: true } } },
      }),
    ]);

    return { items: items.map((item) => this.toDto(item)), total, page, limit };
  }

  /** Bytes of everything the agent sent, measured independently of the express body limit. */
  private measurePayload(dto: AgentSubmitReportDto): number {
    return (
      Buffer.byteLength(JSON.stringify(dto.report), 'utf8') +
      Buffer.byteLength(dto.reportMarkdown ?? '', 'utf8') +
      Buffer.byteLength(dto.rawAgentOutput ?? '', 'utf8')
    );
  }

  private async findCurrentImportByHash(
    intakeId: string,
    reportJsonSha256: string,
  ): Promise<boolean> {
    const delegate = (this.prisma as unknown as Record<string, unknown>)['rightsReviewImport'] as {
      count: (args: Record<string, unknown>) => Promise<number>;
    };
    const count = await delegate.count({
      where: { rightsIntakeId: intakeId, reportJsonSha256, isCurrent: true },
    });
    return count > 0;
  }

  private async runImport(
    submissionId: string,
    intakeId: string,
    dto: AgentSubmitReportDto,
  ): Promise<ImportOutcome> {
    try {
      const record = await this.reviewImports.create(
        intakeId,
        {
          reportJson: dto.report,
          reportMarkdown: dto.reportMarkdown ?? null,
          rawAgentOutput: dto.rawAgentOutput ?? null,
          sourceFileName: dto.sourceFileName ?? null,
        },
        null,
      );

      return {
        id: record['id'] as string,
        importStatus: record['importStatus'] as string,
        validationErrors: (record['validationErrors'] as ValidationIssue[] | null) ?? [],
        validationWarnings: (record['validationWarnings'] as ValidationIssue[] | null) ?? [],
        reportJsonSha256: (record['reportJsonSha256'] as string | null) ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent import failed for submission ${submissionId}: ${message}`);
      await this.submissionDelegate.update({
        where: { id: submissionId },
        data: {
          status: RightsAgentSubmissionStatus.FAILED,
          rejectionCode: 'IMPORT_FAILED',
          rejectionMessageRu: message,
          processedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async finishValidationFailed(
    submission: RightsAgentSubmissionRecord,
    context: AgentTokenRequestContext,
    outcome: ImportOutcome,
    intakeId: string,
    candidateTitle: string,
    declaredSchemaVersion: string | null,
  ): Promise<AgentSubmitResponseDto> {
    // A failed validation only consumes a use when the token forbids retries.
    await this.tokens.registerFailure(context.tokenId, !context.allowRetryOnValidationError);

    const processedAt = new Date();
    const updated = await this.submissionDelegate.update({
      where: { id: submission.id },
      data: {
        status: RightsAgentSubmissionStatus.VALIDATION_FAILED,
        rightsReviewImportId: outcome.id,
        validationErrorCount: outcome.validationErrors.length,
        validationWarningCount: outcome.validationWarnings.length,
        materialization: RightsAgentSubmissionMaterialization.NOT_ATTEMPTED,
        processedAt,
      },
    });

    await this.notifications.create({
      type: RightsNotificationType.AGENT_REPORT_VALIDATION_FAILED,
      severity: RightsNotificationSeverity.ERROR,
      titleRu: 'Отчёт агента не прошёл валидацию',
      messageRu: `Отчёт по интейку «${candidateTitle}» отклонён валидатором: ошибок — ${outcome.validationErrors.length}.`,
      rightsIntakeId: intakeId,
      agentSubmissionId: submission.id,
      rightsReviewImportId: outcome.id,
      payload: { errorCount: outcome.validationErrors.length },
    });

    // 200, not 4xx: the agent is expected to fix the report and resubmit.
    return {
      submissionId: updated.id,
      status: 'VALIDATION_FAILED',
      intakeId,
      schemaVersion: declaredSchemaVersion,
      reviewImportId: outcome.id,
      reportJsonSha256: outcome.reportJsonSha256,
      validationErrors: outcome.validationErrors,
      validationWarnings: outcome.validationWarnings,
      materialization: RightsAgentSubmissionMaterialization.NOT_ATTEMPTED,
      humanApprovalRequired: true,
      messageRu: 'Отчёт сохранён, но не прошёл валидацию. Исправьте ошибки и отправьте снова.',
      receivedAt: processedAt.toISOString(),
    };
  }

  private async runMaterialization(
    context: AgentTokenRequestContext,
    submissionId: string,
    importId: string,
    intakeId: string,
    candidateTitle: string,
  ): Promise<{
    materialization: RightsAgentSubmissionMaterialization;
    error: string | null;
    profileId: string | null;
  }> {
    if (!context.autoMaterialize) {
      return {
        materialization: RightsAgentSubmissionMaterialization.SKIPPED,
        error: null,
        profileId: null,
      };
    }

    try {
      const profile = await this.materialization.materializeFromImport(importId);
      const profileId = (profile['id'] as string | undefined) ?? null;

      await this.notifications.create({
        type: RightsNotificationType.AGENT_REPORT_MATERIALIZED,
        severity: RightsNotificationSeverity.SUCCESS,
        titleRu: 'Создана черновая проверка прав',
        messageRu: `По интейку «${candidateTitle}» создан профиль прав и проверка в статусе HUMAN_REVIEW_REQUIRED.`,
        rightsIntakeId: intakeId,
        agentSubmissionId: submissionId,
        rightsReviewImportId: importId,
        rightsProfileId: profileId,
      });

      await this.notifications.create({
        type: RightsNotificationType.HUMAN_REVIEW_REQUIRED,
        severity: RightsNotificationSeverity.WARNING,
        titleRu: 'Требуется проверка человеком',
        messageRu: `Интейк «${candidateTitle}» ждёт утверждения редактором. Агент не может утвердить результат.`,
        rightsIntakeId: intakeId,
        agentSubmissionId: submissionId,
        rightsReviewImportId: importId,
        rightsProfileId: profileId,
      });

      return {
        materialization: RightsAgentSubmissionMaterialization.SUCCEEDED,
        error: null,
        profileId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent materialization failed for import ${importId}: ${message}`);

      await this.notifications.create({
        type: RightsNotificationType.AGENT_REPORT_MATERIALIZATION_FAILED,
        severity: RightsNotificationSeverity.ERROR,
        titleRu: 'Не удалось построить профиль прав',
        messageRu: `Отчёт по интейку «${candidateTitle}» импортирован, но материализация упала: ${message}.`,
        rightsIntakeId: intakeId,
        agentSubmissionId: submissionId,
        rightsReviewImportId: importId,
      });

      return {
        materialization: RightsAgentSubmissionMaterialization.FAILED,
        error: message,
        profileId: null,
      };
    }
  }

  /**
   * Journals a rejected request and throws. Declared as `never` so callers do not need
   * an unreachable `return` after it.
   */
  private async reject(
    context: AgentTokenRequestContext,
    dto: AgentSubmitReportDto,
    meta: AgentSubmissionMeta,
    options: {
      code: AgentErrorCode;
      status: number;
      details?: Record<string, unknown>;
      payloadSizeBytes?: number;
      declaredSchemaVersion?: string | null;
      reportJsonSha256?: string | null;
    },
  ): Promise<never> {
    await this.submissionDelegate.create({
      data: {
        rightsIntakeId: context.rightsIntakeId,
        uploadTokenId: context.tokenId,
        status: RightsAgentSubmissionStatus.REJECTED,
        declaredSchemaVersion: options.declaredSchemaVersion ?? null,
        reportJsonSha256: options.reportJsonSha256 ?? null,
        payloadSizeBytes: options.payloadSizeBytes ?? null,
        sourceFileName: dto.sourceFileName ?? null,
        agentName: dto.agentName ?? null,
        agentVersion: dto.agentVersion ?? null,
        submittedIp: meta.ip,
        submittedUserAgent: meta.userAgent,
        rejectionCode: options.code,
        rejectionMessageRu: AGENT_ERROR_MESSAGES_RU[options.code],
        processedAt: new Date(),
      },
    });

    throw agentError(options.status, options.code, options.details);
  }

  private toDto(record: RightsAgentSubmissionRecord): AgentSubmissionDto {
    return {
      id: record.id,
      rightsIntakeId: record.rightsIntakeId,
      uploadTokenId: record.uploadTokenId,
      tokenPrefix: record.uploadToken?.tokenPrefix ?? null,
      status: record.status,
      declaredSchemaVersion: record.declaredSchemaVersion,
      reportJsonSha256: record.reportJsonSha256,
      payloadSizeBytes: record.payloadSizeBytes,
      sourceFileName: record.sourceFileName,
      agentName: record.agentName,
      agentVersion: record.agentVersion,
      rightsReviewImportId: record.rightsReviewImportId,
      validationErrorCount: record.validationErrorCount,
      validationWarningCount: record.validationWarningCount,
      rejectionCode: record.rejectionCode,
      rejectionMessageRu: record.rejectionMessageRu,
      materialization: record.materialization,
      materializationError: record.materializationError,
      materializedProfileId: record.materializedProfileId,
      processedAt: record.processedAt ? new Date(record.processedAt).toISOString() : null,
      createdAt: new Date(record.createdAt).toISOString(),
    };
  }
}
