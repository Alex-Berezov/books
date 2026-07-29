import { createHash } from 'crypto';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsNotificationsService } from './rights-notifications.service';
import {
  AGENT_ERROR_CODES,
  AGENT_TOKEN_DISPLAY_PREFIX_LENGTH,
  AGENT_TOKEN_PREFIX,
} from './rights-agent.constants';
import {
  RightsAgentTokenStatus,
  RightsNotificationType,
  type RightsAgentUploadTokenRecord,
} from './rights-agent-interface';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const FUTURE = new Date('2026-08-01T12:00:00.000Z');
const PAST = new Date('2026-07-01T12:00:00.000Z');

const createToken = (
  overrides: Partial<RightsAgentUploadTokenRecord> = {},
): RightsAgentUploadTokenRecord => ({
  id: 'token-1',
  rightsIntakeId: 'intake-1',
  tokenHash: 'hash',
  tokenPrefix: 'brat_AbCdEfG',
  status: RightsAgentTokenStatus.ACTIVE,
  labelRu: null,
  allowedSchemaVersions: null,
  maxUses: 1,
  usedCount: 0,
  failedAttempts: 0,
  maxFailedAttempts: 5,
  allowRetryOnValidationError: true,
  autoMaterialize: true,
  expiresAt: FUTURE,
  issuedByUserId: 'user-1',
  firstUsedAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  lastUsedUserAgent: null,
  revokedAt: null,
  revokedByUserId: null,
  revokeReasonRu: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

interface PrismaStub {
  rightsIntake: Record<string, jest.Mock>;
  rightsAgentUploadToken: Record<string, jest.Mock>;
  $transaction: <T>(callback: (transaction: PrismaStub) => Promise<T>) => Promise<T>;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    rightsIntake: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'intake-1',
        workflowStatus: 'READY_FOR_AGENT',
        candidateTitle: 'Гамлет',
      }),
    },
    rightsAgentUploadToken: {
      findUnique: jest.fn().mockResolvedValue(createToken()),
      findMany: jest.fn().mockResolvedValue([createToken()]),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Partial<RightsAgentUploadTokenRecord> }) =>
          createToken(data),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Partial<RightsAgentUploadTokenRecord> }) =>
          createToken(data),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
  } as unknown as PrismaStub;
  stub.$transaction = <T>(callback: (transaction: PrismaStub) => Promise<T>) => callback(stub);
  return stub;
};

/** Asserts the promise rejects with an agent HttpException carrying `code` (and optionally `status`). */
const expectAgentError = async (
  promise: Promise<unknown>,
  code: string,
  status?: number,
): Promise<void> => {
  await expect(promise).rejects.toThrow(HttpException);
  const error = await promise.catch((caught: unknown) => caught);
  const body = (error as HttpException).getResponse() as { code: string };
  expect(body.code).toBe(code);
  if (status !== undefined) {
    expect((error as HttpException).getStatus()).toBe(status);
  }
};

describe('RightsAgentTokenService', () => {
  let prisma: PrismaStub;
  let notifications: { create: jest.Mock };
  let service: RightsAgentTokenService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = createPrismaStub();
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    service = new RightsAgentTokenService(
      prisma as unknown as PrismaService,
      notifications as unknown as RightsNotificationsService,
      new ConfigService({}),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('issue', () => {
    it('returns the raw token and persists only its sha256', async () => {
      const result = await service.issue('intake-1', {}, 'user-1');

      expect(result.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);

      const data = prisma.rightsAgentUploadToken.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['tokenHash']).toBe(
        createHash('sha256').update(result.token, 'utf8').digest('hex'),
      );
      expect(data['tokenPrefix']).toBe(result.token.slice(0, AGENT_TOKEN_DISPLAY_PREFIX_LENGTH));
      expect(String(data['tokenPrefix'])).toHaveLength(AGENT_TOKEN_DISPLAY_PREFIX_LENGTH);
      expect(JSON.stringify(data)).not.toContain(result.token);
    });

    it('revokes any previously active token of the same intake', async () => {
      await service.issue('intake-1', {}, 'user-1');

      expect(prisma.rightsAgentUploadToken.updateMany).toHaveBeenCalledWith({
        where: { rightsIntakeId: 'intake-1', status: RightsAgentTokenStatus.ACTIVE },
        data: expect.objectContaining({
          status: RightsAgentTokenStatus.REVOKED,
          revokeReasonRu: 'Superseded by a newly issued token',
        }),
      });
    });

    it('writes an AGENT_TOKEN_ISSUED notification', async () => {
      await service.issue('intake-1', {}, 'user-1');

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: RightsNotificationType.AGENT_TOKEN_ISSUED }),
        expect.anything(),
      );
    });

    it('rejects an intake that is not READY_FOR_AGENT', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue({
        id: 'intake-1',
        workflowStatus: 'DRAFT',
        candidateTitle: 'Гамлет',
      });

      await expectAgentError(
        service.issue('intake-1', {}, 'user-1'),
        AGENT_ERROR_CODES.INTAKE_NOT_ACCEPTING_TOKENS,
        400,
      );
    });

    it('rejects a missing intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);

      await expectAgentError(
        service.issue('intake-1', {}, 'user-1'),
        AGENT_ERROR_CODES.INTAKE_NOT_FOUND,
        404,
      );
    });

    it('rejects ttlHours = 0 and ttlHours = 1000', async () => {
      await expectAgentError(
        service.issue('intake-1', { ttlHours: 0 }, 'user-1'),
        AGENT_ERROR_CODES.INVALID_TOKEN_TTL,
        400,
      );
      await expectAgentError(
        service.issue('intake-1', { ttlHours: 1000 }, 'user-1'),
        AGENT_ERROR_CODES.INVALID_TOKEN_TTL,
        400,
      );
    });

    it('rejects maxUses outside [1, 10]', async () => {
      await expectAgentError(
        service.issue('intake-1', { maxUses: 0 }, 'user-1'),
        AGENT_ERROR_CODES.INVALID_TOKEN_MAX_USES,
        400,
      );
      await expectAgentError(
        service.issue('intake-1', { maxUses: 11 }, 'user-1'),
        AGENT_ERROR_CODES.INVALID_TOKEN_MAX_USES,
        400,
      );
    });

    it('rejects an unsupported allowedSchemaVersions entry', async () => {
      await expectAgentError(
        service.issue('intake-1', { allowedSchemaVersions: ['2.0'] }, 'user-1'),
        AGENT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
        400,
      );
      expect(prisma.rightsAgentUploadToken.create).not.toHaveBeenCalled();
    });
  });

  describe('resolveForRequest', () => {
    it('returns AGENT_TOKEN_INVALID for an unknown hash', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(null);

      await expect(service.resolveForRequest('brat_nope')).resolves.toEqual({
        ok: false,
        code: AGENT_ERROR_CODES.AGENT_TOKEN_INVALID,
      });
    });

    it('returns AGENT_TOKEN_REVOKED for a revoked token', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(
        createToken({ status: RightsAgentTokenStatus.REVOKED }),
      );

      await expect(service.resolveForRequest('brat_x')).resolves.toEqual({
        ok: false,
        code: AGENT_ERROR_CODES.AGENT_TOKEN_REVOKED,
      });
    });

    it('returns AGENT_TOKEN_EXPIRED and lazily flips the status to EXPIRED', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(createToken({ expiresAt: PAST }));

      await expect(service.resolveForRequest('brat_x')).resolves.toEqual({
        ok: false,
        code: AGENT_ERROR_CODES.AGENT_TOKEN_EXPIRED,
      });
      expect(prisma.rightsAgentUploadToken.update).toHaveBeenCalledWith({
        where: { id: 'token-1' },
        data: { status: RightsAgentTokenStatus.EXPIRED },
      });
    });

    it('returns AGENT_TOKEN_EXHAUSTED when all uses are spent', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(
        createToken({ usedCount: 1, maxUses: 1 }),
      );

      await expect(service.resolveForRequest('brat_x')).resolves.toEqual({
        ok: false,
        code: AGENT_ERROR_CODES.AGENT_TOKEN_EXHAUSTED,
      });
    });

    it('returns AGENT_TOKEN_TOO_MANY_FAILURES past the failure limit', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(
        createToken({ failedAttempts: 5, maxFailedAttempts: 5 }),
      );

      await expect(service.resolveForRequest('brat_x')).resolves.toEqual({
        ok: false,
        code: AGENT_ERROR_CODES.AGENT_TOKEN_TOO_MANY_FAILURES,
      });
    });

    it('resolves a usable token', async () => {
      const resolution = await service.resolveForRequest('brat_x');

      expect(resolution.ok).toBe(true);
      expect(prisma.rightsAgentUploadToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: createHash('sha256').update('brat_x', 'utf8').digest('hex') },
      });
    });
  });

  describe('usage accounting', () => {
    it('registerSuccess moves a single-use token to USED', async () => {
      await service.registerSuccess('token-1');

      const data = prisma.rightsAgentUploadToken.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['usedCount']).toBe(1);
      expect(data['status']).toBe(RightsAgentTokenStatus.USED);
      expect(data['firstUsedAt']).toEqual(NOW);
    });

    it('registerFailure(id, false) increments failedAttempts but not usedCount', async () => {
      await service.registerFailure('token-1', false);

      const data = prisma.rightsAgentUploadToken.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['failedAttempts']).toBe(1);
      expect(data['usedCount']).toBe(0);
      expect(data['status']).toBeUndefined();
    });

    it('registerFailure(id, true) also consumes a use', async () => {
      await service.registerFailure('token-1', true);

      const data = prisma.rightsAgentUploadToken.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['usedCount']).toBe(1);
      expect(data['status']).toBe(RightsAgentTokenStatus.USED);
    });

    it('registerFailure revokes the token once the failure limit is reached', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(
        createToken({ failedAttempts: 4, maxFailedAttempts: 5 }),
      );

      await service.registerFailure('token-1', false);

      const data = prisma.rightsAgentUploadToken.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['status']).toBe(RightsAgentTokenStatus.REVOKED);
      expect(data['revokeReasonRu']).toBe('Exceeded failed attempt limit');
    });
  });

  describe('revoke', () => {
    it('revokes an active token and records the reason', async () => {
      await service.revoke('token-1', { reasonRu: 'Больше не нужен' }, 'user-1');

      expect(prisma.rightsAgentUploadToken.update).toHaveBeenCalledWith({
        where: { id: 'token-1' },
        data: expect.objectContaining({
          status: RightsAgentTokenStatus.REVOKED,
          revokedByUserId: 'user-1',
          revokeReasonRu: 'Больше не нужен',
        }),
      });
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: RightsNotificationType.AGENT_TOKEN_REVOKED }),
      );
    });

    it('a second revoke conflicts with 409 AGENT_TOKEN_ALREADY_REVOKED', async () => {
      prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(
        createToken({ status: RightsAgentTokenStatus.REVOKED }),
      );

      await expectAgentError(
        service.revoke('token-1', { reasonRu: 'Повтор' }, 'user-1'),
        AGENT_ERROR_CODES.AGENT_TOKEN_ALREADY_REVOKED,
        409,
      );
    });
  });

  it('computes isUsable / isExpired / remainingUses without storing them', async () => {
    prisma.rightsAgentUploadToken.findUnique.mockResolvedValue(
      createToken({ maxUses: 3, usedCount: 1 }),
    );

    const dto = await service.getById('token-1');

    expect(dto.isExpired).toBe(false);
    expect(dto.isUsable).toBe(true);
    expect(dto.remainingUses).toBe(2);
  });
});
