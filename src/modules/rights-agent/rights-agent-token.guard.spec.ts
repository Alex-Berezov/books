import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RightsAgentTokenGuard, type AgentRequest } from './rights-agent-token.guard';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { AGENT_ERROR_CODES, AGENT_TOKEN_HEADER } from './rights-agent.constants';
import {
  RightsAgentTokenStatus,
  type RightsAgentUploadTokenRecord,
} from './rights-agent-interface';

const usableToken: RightsAgentUploadTokenRecord = {
  id: 'token-1',
  rightsIntakeId: 'intake-1',
  tokenHash: 'hash',
  tokenPrefix: 'brat_AbCdEfG',
  status: RightsAgentTokenStatus.ACTIVE,
  labelRu: null,
  allowedSchemaVersions: ['1.0'],
  maxUses: 1,
  usedCount: 0,
  failedAttempts: 0,
  maxFailedAttempts: 5,
  allowRetryOnValidationError: false,
  autoMaterialize: true,
  expiresAt: new Date('2026-08-01T12:00:00.000Z'),
  issuedByUserId: 'user-1',
  firstUsedAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  lastUsedUserAgent: null,
  revokedAt: null,
  revokedByUserId: null,
  revokeReasonRu: null,
  createdAt: new Date('2026-07-29T12:00:00.000Z'),
  updatedAt: new Date('2026-07-29T12:00:00.000Z'),
};

const createContext = (req: AgentRequest): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const expectGuardError = async (
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

describe('RightsAgentTokenGuard', () => {
  let tokenService: { resolveForRequest: jest.Mock };

  const buildGuard = (env: Record<string, string> = {}): RightsAgentTokenGuard =>
    new RightsAgentTokenGuard(
      tokenService as unknown as RightsAgentTokenService,
      new ConfigService(env),
    );

  beforeEach(() => {
    tokenService = {
      resolveForRequest: jest.fn().mockResolvedValue({ ok: true, token: usableToken }),
    };
  });

  it('rejects a request without any token', async () => {
    const guard = buildGuard();

    await expectGuardError(
      guard.canActivate(createContext({ headers: {} })),
      AGENT_ERROR_CODES.AGENT_TOKEN_MISSING,
      401,
    );
    expect(tokenService.resolveForRequest).not.toHaveBeenCalled();
  });

  it('ignores a user JWT in Authorization: Bearer and never parses it as an agent token', async () => {
    const guard = buildGuard();
    const req: AgentRequest = {
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' },
    };

    await expectGuardError(
      guard.canActivate(createContext(req)),
      AGENT_ERROR_CODES.AGENT_TOKEN_MISSING,
      401,
    );
    expect(tokenService.resolveForRequest).not.toHaveBeenCalled();
  });

  it('accepts Authorization: Bearer when the value carries the agent prefix', async () => {
    const guard = buildGuard();
    const req: AgentRequest = { headers: { authorization: 'Bearer brat_secret' } };

    await expect(guard.canActivate(createContext(req))).resolves.toBe(true);
    expect(tokenService.resolveForRequest).toHaveBeenCalledWith('brat_secret');
  });

  it('populates req.agentToken from a valid token', async () => {
    const guard = buildGuard();
    const req: AgentRequest = { headers: { [AGENT_TOKEN_HEADER]: 'brat_secret' } };

    await expect(guard.canActivate(createContext(req))).resolves.toBe(true);
    expect(req.agentToken).toEqual({
      tokenId: 'token-1',
      rightsIntakeId: 'intake-1',
      allowedSchemaVersions: ['1.0'],
      autoMaterialize: true,
      allowRetryOnValidationError: false,
    });
  });

  it('returns 503 when RIGHTS_AGENT_UPLOAD_ENABLED=0', async () => {
    const guard = buildGuard({ RIGHTS_AGENT_UPLOAD_ENABLED: '0' });

    await expectGuardError(
      guard.canActivate(createContext({ headers: { [AGENT_TOKEN_HEADER]: 'brat_secret' } })),
      AGENT_ERROR_CODES.AGENT_UPLOAD_DISABLED,
      503,
    );
  });

  it('maps an expired token to 401 AGENT_TOKEN_EXPIRED', async () => {
    tokenService.resolveForRequest.mockResolvedValue({
      ok: false,
      code: AGENT_ERROR_CODES.AGENT_TOKEN_EXPIRED,
    });
    const guard = buildGuard();

    await expectGuardError(
      guard.canActivate(createContext({ headers: { [AGENT_TOKEN_HEADER]: 'brat_secret' } })),
      AGENT_ERROR_CODES.AGENT_TOKEN_EXPIRED,
      401,
    );
  });

  it('maps an exhausted token to 401 AGENT_TOKEN_EXHAUSTED', async () => {
    tokenService.resolveForRequest.mockResolvedValue({
      ok: false,
      code: AGENT_ERROR_CODES.AGENT_TOKEN_EXHAUSTED,
    });
    const guard = buildGuard();

    await expectGuardError(
      guard.canActivate(createContext({ headers: { [AGENT_TOKEN_HEADER]: 'brat_secret' } })),
      AGENT_ERROR_CODES.AGENT_TOKEN_EXHAUSTED,
      401,
    );
  });
});
