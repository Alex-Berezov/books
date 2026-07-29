import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsMaterializationService } from '../rights-intake/rights-materialization.service';
import { RightsReviewImportService } from '../rights-intake/rights-review-import.service';
import { RightsAgentSubmissionService } from './rights-agent-submission.service';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsNotificationsService } from './rights-notifications.service';
import { AGENT_ERROR_CODES } from './rights-agent.constants';
import {
  RightsAgentSubmissionMaterialization,
  RightsAgentSubmissionStatus,
  RightsNotificationType,
  type AgentTokenRequestContext,
  type RightsAgentSubmissionRecord,
} from './rights-agent-interface';
import type { AgentSubmitReportDto } from './dto/agent-submit-report.dto';

const NOW = new Date('2026-07-29T12:00:00.000Z');

const context: AgentTokenRequestContext = {
  tokenId: 'token-1',
  rightsIntakeId: 'intake-1',
  allowedSchemaVersions: null,
  autoMaterialize: true,
  allowRetryOnValidationError: true,
};

const report: Record<string, unknown> = {
  schemaVersion: '1.0',
  intakeId: 'intake-1',
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
};

const dto: AgentSubmitReportDto = { report, agentName: 'chatgpt-clearance', agentVersion: '1' };

const meta = { ip: '203.0.113.7', userAgent: 'agent/1.0' };

const createSubmission = (
  overrides: Partial<RightsAgentSubmissionRecord> = {},
): RightsAgentSubmissionRecord => ({
  id: 'submission-1',
  rightsIntakeId: 'intake-1',
  uploadTokenId: 'token-1',
  status: RightsAgentSubmissionStatus.RECEIVED,
  declaredSchemaVersion: '1.0',
  reportJsonSha256: 'sha',
  payloadSizeBytes: 100,
  sourceFileName: null,
  agentName: 'chatgpt-clearance',
  agentVersion: '1',
  submittedIp: meta.ip,
  submittedUserAgent: meta.userAgent,
  rightsReviewImportId: null,
  validationErrorCount: 0,
  validationWarningCount: 0,
  rejectionCode: null,
  rejectionMessageRu: null,
  materialization: RightsAgentSubmissionMaterialization.NOT_ATTEMPTED,
  materializationError: null,
  materializedProfileId: null,
  processedAt: null,
  createdAt: NOW,
  ...overrides,
});

interface PrismaStub {
  rightsIntake: Record<string, jest.Mock>;
  rightsAgentSubmission: Record<string, jest.Mock>;
  rightsReviewImport: Record<string, jest.Mock>;
}

const createPrismaStub = (): PrismaStub => ({
  rightsIntake: {
    findUnique: jest.fn().mockResolvedValue({
      id: 'intake-1',
      workflowStatus: 'READY_FOR_AGENT',
      candidateTitle: 'Гамлет',
    }),
    update: jest.fn(),
  },
  rightsAgentSubmission: {
    create: jest
      .fn()
      .mockImplementation(({ data }: { data: Partial<RightsAgentSubmissionRecord> }) =>
        createSubmission(data),
      ),
    update: jest
      .fn()
      .mockImplementation(({ data }: { data: Partial<RightsAgentSubmissionRecord> }) =>
        createSubmission(data),
      ),
    findUnique: jest.fn().mockResolvedValue(createSubmission()),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  rightsReviewImport: {
    count: jest.fn().mockResolvedValue(0),
  },
});

const expectAgentError = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> => {
  await expect(promise).rejects.toThrow(HttpException);
  const error = await promise.catch((caught: unknown) => caught);
  const body = (error as HttpException).getResponse() as { code: string };
  expect(body.code).toBe(code);
  expect((error as HttpException).getStatus()).toBe(status);
};

describe('RightsAgentSubmissionService', () => {
  let prisma: PrismaStub;
  let reviewImports: { create: jest.Mock };
  let materialization: { materializeFromImport: jest.Mock };
  let tokens: { registerSuccess: jest.Mock; registerFailure: jest.Mock; touchUsage: jest.Mock };
  let notifications: { create: jest.Mock };
  let service: RightsAgentSubmissionService;

  const build = (): RightsAgentSubmissionService =>
    new RightsAgentSubmissionService(
      prisma as unknown as PrismaService,
      reviewImports as unknown as RightsReviewImportService,
      materialization as unknown as RightsMaterializationService,
      tokens as unknown as RightsAgentTokenService,
      notifications as unknown as RightsNotificationsService,
      new ConfigService({}),
    );

  const notificationTypes = (): string[] =>
    notifications.create.mock.calls.map((call) => (call[0] as { type: string }).type);

  beforeEach(() => {
    prisma = createPrismaStub();
    reviewImports = {
      create: jest.fn().mockResolvedValue({
        id: 'import-1',
        importStatus: 'VALIDATED',
        validationErrors: null,
        validationWarnings: [{ path: 'evidence', message: 'empty', code: 'EMPTY_ARRAY' }],
        reportJsonSha256: 'sha',
      }),
    };
    materialization = { materializeFromImport: jest.fn().mockResolvedValue({ id: 'profile-1' }) };
    tokens = {
      registerSuccess: jest.fn().mockResolvedValue(undefined),
      registerFailure: jest.fn().mockResolvedValue(undefined),
      touchUsage: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    service = build();
  });

  it('happy path: validates, consumes the token, materializes and notifies three times', async () => {
    const result = await service.submit(context, dto, meta);

    expect(result.status).toBe('VALIDATED');
    expect(result.reviewImportId).toBe('import-1');
    expect(result.materialization).toBe(RightsAgentSubmissionMaterialization.SUCCEEDED);
    expect(tokens.registerSuccess).toHaveBeenCalledWith('token-1');
    expect(materialization.materializeFromImport).toHaveBeenCalledWith('import-1');
    expect(notificationTypes()).toEqual([
      RightsNotificationType.AGENT_REPORT_RECEIVED,
      RightsNotificationType.AGENT_REPORT_MATERIALIZED,
      RightsNotificationType.HUMAN_REVIEW_REQUIRED,
    ]);
  });

  it('skips materialization when the token disables it', async () => {
    const result = await service.submit({ ...context, autoMaterialize: false }, dto, meta);

    expect(result.materialization).toBe(RightsAgentSubmissionMaterialization.SKIPPED);
    expect(materialization.materializeFromImport).not.toHaveBeenCalled();
  });

  it('returns 200 VALIDATION_FAILED and does not consume a use when retries are allowed', async () => {
    reviewImports.create.mockResolvedValue({
      id: 'import-2',
      importStatus: 'VALIDATION_FAILED',
      validationErrors: [{ path: 'summaryRu', message: 'required', code: 'MISSING_FIELD' }],
      validationWarnings: null,
      reportJsonSha256: 'sha',
    });

    const result = await service.submit(context, dto, meta);

    expect(result.status).toBe('VALIDATION_FAILED');
    expect(result.validationErrors).toHaveLength(1);
    expect(tokens.registerFailure).toHaveBeenCalledWith('token-1', false);
    expect(tokens.registerSuccess).not.toHaveBeenCalled();
    expect(notificationTypes()).toEqual([RightsNotificationType.AGENT_REPORT_VALIDATION_FAILED]);
  });

  it('consumes a use on validation failure when retries are disabled', async () => {
    reviewImports.create.mockResolvedValue({
      id: 'import-2',
      importStatus: 'VALIDATION_FAILED',
      validationErrors: [{ path: 'summaryRu', message: 'required', code: 'MISSING_FIELD' }],
      validationWarnings: null,
      reportJsonSha256: 'sha',
    });

    await service.submit({ ...context, allowRetryOnValidationError: false }, dto, meta);

    expect(tokens.registerFailure).toHaveBeenCalledWith('token-1', true);
  });

  it('rejects a body intakeId that does not match the token', async () => {
    await expectAgentError(
      service.submit(context, { ...dto, intakeId: 'other-intake' }, meta),
      AGENT_ERROR_CODES.AGENT_TOKEN_INTAKE_MISMATCH,
      403,
    );
    expect(prisma.rightsAgentSubmission.create).not.toHaveBeenCalled();
  });

  it('rejects an APPROVED intake with 409 and journals a REJECTED submission', async () => {
    prisma.rightsIntake.findUnique.mockResolvedValue({
      id: 'intake-1',
      workflowStatus: 'APPROVED',
      candidateTitle: 'Гамлет',
    });

    await expectAgentError(
      service.submit(context, dto, meta),
      AGENT_ERROR_CODES.INTAKE_NOT_ACCEPTING_SUBMISSIONS,
      409,
    );
    expect(prisma.rightsAgentSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: RightsAgentSubmissionStatus.REJECTED,
        rejectionCode: AGENT_ERROR_CODES.INTAKE_NOT_ACCEPTING_SUBMISSIONS,
      }),
    });
  });

  it('rejects an oversized payload with 413', async () => {
    service = new RightsAgentSubmissionService(
      prisma as unknown as PrismaService,
      reviewImports as unknown as RightsReviewImportService,
      materialization as unknown as RightsMaterializationService,
      tokens as unknown as RightsAgentTokenService,
      notifications as unknown as RightsNotificationsService,
      new ConfigService({ RIGHTS_AGENT_MAX_REPORT_BYTES: '10' }),
    );

    await expectAgentError(
      service.submit(context, dto, meta),
      AGENT_ERROR_CODES.REPORT_TOO_LARGE,
      413,
    );
  });

  it('rejects an unsupported schemaVersion and lists the supported ones', async () => {
    const promise = service.submit(
      context,
      { ...dto, report: { ...report, schemaVersion: '2.0' } },
      meta,
    );

    await expect(promise).rejects.toThrow(HttpException);
    const error = await promise.catch((caught: unknown) => caught);
    const body = (error as HttpException).getResponse() as {
      code: string;
      details?: { supportedSchemaVersions?: string[] };
    };
    expect(body.code).toBe(AGENT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
    expect(body.details?.supportedSchemaVersions).toEqual(['1.0']);
    expect((error as HttpException).getStatus()).toBe(400);
  });

  it('rejects a version the token does not allow', async () => {
    await expectAgentError(
      service.submit({ ...context, allowedSchemaVersions: ['9.9'] }, dto, meta),
      AGENT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      400,
    );
  });

  it('rejects a duplicate report with 409 without consuming a use', async () => {
    prisma.rightsReviewImport.count.mockResolvedValue(1);

    await expectAgentError(
      service.submit(context, dto, meta),
      AGENT_ERROR_CODES.DUPLICATE_SUBMISSION,
      409,
    );
    expect(tokens.registerFailure).toHaveBeenCalledWith('token-1', false);
    expect(tokens.registerSuccess).not.toHaveBeenCalled();
  });

  it('keeps the import when materialization throws and still answers 200', async () => {
    materialization.materializeFromImport.mockRejectedValue(new Error('materialization boom'));

    const result = await service.submit(context, dto, meta);

    expect(result.status).toBe('VALIDATED');
    expect(result.materialization).toBe(RightsAgentSubmissionMaterialization.FAILED);
    expect(notificationTypes()).toContain(
      RightsNotificationType.AGENT_REPORT_MATERIALIZATION_FAILED,
    );
    expect(prisma.rightsAgentSubmission.update).toHaveBeenCalledWith({
      where: { id: 'submission-1' },
      data: expect.objectContaining({ materializationError: 'materialization boom' }),
    });
  });

  it('imports with importedByUserId = null — no human performed the import', async () => {
    await service.submit(context, dto, meta);

    expect(reviewImports.create).toHaveBeenCalledWith('intake-1', expect.anything(), null);
  });

  it('never approves the intake or touches approvedReviewId', async () => {
    await service.submit(context, dto, meta);

    expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
  });

  it('always answers humanApprovalRequired = true', async () => {
    const validated = await service.submit(context, dto, meta);
    expect(validated.humanApprovalRequired).toBe(true);

    reviewImports.create.mockResolvedValue({
      id: 'import-2',
      importStatus: 'VALIDATION_FAILED',
      validationErrors: [],
      validationWarnings: [],
      reportJsonSha256: 'sha',
    });
    const failed = await service.submit(context, dto, meta);
    expect(failed.humanApprovalRequired).toBe(true);
  });

  it('exposes no rights profile id to the agent', async () => {
    const result = await service.submit(context, dto, meta);

    expect(JSON.stringify(result)).not.toContain('profile-1');
  });
});
