import { createHash, randomBytes } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RIGHTS_REPORT_SCHEMA_VERSIONS,
  isSupportedReportSchemaVersion,
} from '../rights-intake/rights-review-schema.registry';
import { RightsNotificationsService } from './rights-notifications.service';
import {
  AGENT_ERROR_CODES,
  AGENT_TOKEN_DEFAULT_MAX_FAILED_ATTEMPTS,
  AGENT_TOKEN_DEFAULT_MAX_USES,
  AGENT_TOKEN_DEFAULT_TTL_HOURS,
  AGENT_TOKEN_DISPLAY_PREFIX_LENGTH,
  AGENT_TOKEN_ENTROPY_BYTES,
  AGENT_TOKEN_ISSUABLE_INTAKE_STATUSES,
  AGENT_TOKEN_MAX_MAX_USES,
  AGENT_TOKEN_MAX_TTL_HOURS,
  AGENT_TOKEN_MIN_TTL_HOURS,
  AGENT_TOKEN_PREFIX,
} from './rights-agent.constants';
import { agentError } from './rights-agent.errors';
import {
  RightsAgentTokenStatus,
  RightsNotificationSeverity,
  RightsNotificationType,
  toStringArray,
  type AgentDatabaseClient,
  type RightsAgentUploadTokenDelegate,
  type RightsAgentUploadTokenRecord,
  type TokenResolution,
} from './rights-agent-interface';
import type { CreateAgentTokenDto } from './dto/create-agent-token.dto';
import type { ListAgentTokensDto } from './dto/list-agent-tokens.dto';
import type { RevokeAgentTokenDto } from './dto/revoke-agent-token.dto';
import type {
  AgentTokenDto,
  AgentTokenIssuedDto,
  AgentTokenListResponseDto,
} from './dto/agent-token-response.dto';

const MS_PER_HOUR = 60 * 60 * 1000;

@Injectable()
export class RightsAgentTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: RightsNotificationsService,
    private readonly config: ConfigService,
  ) {}

  private get tokenDelegate(): RightsAgentUploadTokenDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsAgentUploadToken'
    ] as RightsAgentUploadTokenDelegate;
  }

  private get defaultTtlHours(): number {
    const raw = Number(this.config.get('RIGHTS_AGENT_TOKEN_TTL_HOURS'));
    return Number.isFinite(raw) && raw > 0 ? raw : AGENT_TOKEN_DEFAULT_TTL_HOURS;
  }

  /**
   * Issues a fresh token. Any previously active token of the same intake is revoked in the
   * same transaction — an intake always has at most one usable token.
   * The raw token value is returned here and nowhere else; only its sha256 is stored.
   */
  async issue(
    intakeId: string,
    dto: CreateAgentTokenDto,
    userId: string,
  ): Promise<AgentTokenIssuedDto> {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.INTAKE_NOT_FOUND);
    }
    if (
      !(AGENT_TOKEN_ISSUABLE_INTAKE_STATUSES as readonly string[]).includes(intake.workflowStatus)
    ) {
      throw agentError(HttpStatus.BAD_REQUEST, AGENT_ERROR_CODES.INTAKE_NOT_ACCEPTING_TOKENS, {
        workflowStatus: intake.workflowStatus,
        allowedStatuses: [...AGENT_TOKEN_ISSUABLE_INTAKE_STATUSES],
      });
    }

    const ttlHours = dto.ttlHours ?? this.defaultTtlHours;
    if (
      !Number.isInteger(ttlHours) ||
      ttlHours < AGENT_TOKEN_MIN_TTL_HOURS ||
      ttlHours > AGENT_TOKEN_MAX_TTL_HOURS
    ) {
      throw agentError(HttpStatus.BAD_REQUEST, AGENT_ERROR_CODES.INVALID_TOKEN_TTL, {
        min: AGENT_TOKEN_MIN_TTL_HOURS,
        max: AGENT_TOKEN_MAX_TTL_HOURS,
      });
    }

    const maxUses = dto.maxUses ?? AGENT_TOKEN_DEFAULT_MAX_USES;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > AGENT_TOKEN_MAX_MAX_USES) {
      throw agentError(HttpStatus.BAD_REQUEST, AGENT_ERROR_CODES.INVALID_TOKEN_MAX_USES, {
        min: 1,
        max: AGENT_TOKEN_MAX_MAX_USES,
      });
    }

    const allowedSchemaVersions = dto.allowedSchemaVersions ?? null;
    if (allowedSchemaVersions) {
      const unsupported = allowedSchemaVersions.filter((v) => !isSupportedReportSchemaVersion(v));
      if (allowedSchemaVersions.length === 0 || unsupported.length > 0) {
        throw agentError(HttpStatus.BAD_REQUEST, AGENT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION, {
          unsupported,
          supportedSchemaVersions: [...RIGHTS_REPORT_SCHEMA_VERSIONS],
        });
      }
    }

    const raw = `${AGENT_TOKEN_PREFIX}${randomBytes(AGENT_TOKEN_ENTROPY_BYTES).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    const tokenPrefix = raw.slice(0, AGENT_TOKEN_DISPLAY_PREFIX_LENGTH);
    const expiresAt = new Date(Date.now() + ttlHours * MS_PER_HOUR);

    const created = await this.prisma.$transaction(async (tx) => {
      const client = tx as unknown as AgentDatabaseClient;

      await client.rightsAgentUploadToken.updateMany({
        where: { rightsIntakeId: intakeId, status: RightsAgentTokenStatus.ACTIVE },
        data: {
          status: RightsAgentTokenStatus.REVOKED,
          revokedAt: new Date(),
          revokedByUserId: userId,
          revokeReasonRu: 'Superseded by a newly issued token',
        },
      });

      const token = await client.rightsAgentUploadToken.create({
        data: {
          rightsIntakeId: intakeId,
          tokenHash,
          tokenPrefix,
          status: RightsAgentTokenStatus.ACTIVE,
          labelRu: dto.labelRu ?? null,
          allowedSchemaVersions: allowedSchemaVersions ?? undefined,
          maxUses,
          maxFailedAttempts: AGENT_TOKEN_DEFAULT_MAX_FAILED_ATTEMPTS,
          allowRetryOnValidationError: dto.allowRetryOnValidationError ?? true,
          autoMaterialize: dto.autoMaterialize ?? true,
          expiresAt,
          issuedByUserId: userId,
        },
      });

      await this.notifications.create(
        {
          type: RightsNotificationType.AGENT_TOKEN_ISSUED,
          severity: RightsNotificationSeverity.INFO,
          titleRu: 'Выпущен токен для агента',
          messageRu: `Для интейка «${intake.candidateTitle}» выпущен одноразовый токен, действует до ${expiresAt.toISOString()}.`,
          targetUserId: userId,
          rightsIntakeId: intakeId,
          payload: { tokenPrefix, maxUses, expiresAt: expiresAt.toISOString() },
        },
        client,
      );

      return token;
    });

    return { ...this.toDto(created), token: raw };
  }

  async listByIntake(
    intakeId: string,
    query: ListAgentTokensDto,
  ): Promise<AgentTokenListResponseDto> {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.INTAKE_NOT_FOUND);
    }

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { rightsIntakeId: intakeId };
    if (query.status) {
      where['status'] = query.status;
    }

    const [total, items] = await Promise.all([
      this.tokenDelegate.count({ where }),
      this.tokenDelegate.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);

    return { items: items.map((item) => this.toDto(item)), total, page, limit };
  }

  async getById(tokenId: string): Promise<AgentTokenDto> {
    const token = await this.tokenDelegate.findUnique({ where: { id: tokenId } });
    if (!token) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.AGENT_TOKEN_NOT_FOUND);
    }
    return this.toDto(token);
  }

  async revoke(tokenId: string, dto: RevokeAgentTokenDto, userId: string): Promise<AgentTokenDto> {
    const token = await this.tokenDelegate.findUnique({ where: { id: tokenId } });
    if (!token) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.AGENT_TOKEN_NOT_FOUND);
    }
    if (token.status === RightsAgentTokenStatus.REVOKED) {
      throw agentError(HttpStatus.CONFLICT, AGENT_ERROR_CODES.AGENT_TOKEN_ALREADY_REVOKED);
    }

    const updated = await this.tokenDelegate.update({
      where: { id: tokenId },
      data: {
        status: RightsAgentTokenStatus.REVOKED,
        revokedAt: new Date(),
        revokedByUserId: userId,
        revokeReasonRu: dto.reasonRu,
      },
    });

    const intake = await this.prisma.rightsIntake.findUnique({
      where: { id: token.rightsIntakeId },
    });

    await this.notifications.create({
      type: RightsNotificationType.AGENT_TOKEN_REVOKED,
      severity: RightsNotificationSeverity.WARNING,
      titleRu: 'Токен агента отозван',
      messageRu: `Токен ${token.tokenPrefix}… для интейка «${intake?.candidateTitle ?? token.rightsIntakeId}» отозван. Причина: ${dto.reasonRu}.`,
      targetUserId: userId,
      rightsIntakeId: token.rightsIntakeId,
      payload: { tokenPrefix: token.tokenPrefix, reasonRu: dto.reasonRu },
    });

    return this.toDto(updated);
  }

  /** Resolves the raw token presented by an agent request. Never throws — the guard maps codes. */
  async resolveForRequest(rawToken: string): Promise<TokenResolution> {
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
    const token = await this.tokenDelegate.findUnique({ where: { tokenHash } });

    if (!token) {
      return { ok: false, code: AGENT_ERROR_CODES.AGENT_TOKEN_INVALID };
    }
    if (token.status === RightsAgentTokenStatus.REVOKED) {
      return { ok: false, code: AGENT_ERROR_CODES.AGENT_TOKEN_REVOKED };
    }
    if (new Date(token.expiresAt).getTime() <= Date.now()) {
      if (token.status !== RightsAgentTokenStatus.EXPIRED) {
        await this.tokenDelegate.update({
          where: { id: token.id },
          data: { status: RightsAgentTokenStatus.EXPIRED },
        });
      }
      return { ok: false, code: AGENT_ERROR_CODES.AGENT_TOKEN_EXPIRED };
    }
    if (token.status === RightsAgentTokenStatus.USED || token.usedCount >= token.maxUses) {
      return { ok: false, code: AGENT_ERROR_CODES.AGENT_TOKEN_EXHAUSTED };
    }
    if (token.failedAttempts >= token.maxFailedAttempts) {
      return { ok: false, code: AGENT_ERROR_CODES.AGENT_TOKEN_TOO_MANY_FAILURES };
    }

    return { ok: true, token };
  }

  async registerSuccess(tokenId: string): Promise<void> {
    const token = await this.tokenDelegate.findUnique({ where: { id: tokenId } });
    if (!token) return;

    const usedCount = token.usedCount + 1;
    const now = new Date();
    await this.tokenDelegate.update({
      where: { id: tokenId },
      data: {
        usedCount,
        lastUsedAt: now,
        firstUsedAt: token.firstUsedAt ?? now,
        status:
          usedCount >= token.maxUses ? RightsAgentTokenStatus.USED : RightsAgentTokenStatus.ACTIVE,
      },
    });
  }

  /**
   * @param consumesUse when true the failed attempt also consumes one of the allowed uses
   *   (token was issued with `allowRetryOnValidationError: false`).
   */
  async registerFailure(tokenId: string, consumesUse: boolean): Promise<void> {
    const token = await this.tokenDelegate.findUnique({ where: { id: tokenId } });
    if (!token) return;

    const failedAttempts = token.failedAttempts + 1;
    const usedCount = consumesUse ? token.usedCount + 1 : token.usedCount;
    const now = new Date();

    const data: Record<string, unknown> = {
      failedAttempts,
      usedCount,
      lastUsedAt: now,
      firstUsedAt: token.firstUsedAt ?? now,
    };

    if (failedAttempts >= token.maxFailedAttempts) {
      data['status'] = RightsAgentTokenStatus.REVOKED;
      data['revokedAt'] = now;
      data['revokeReasonRu'] = 'Exceeded failed attempt limit';
    } else if (consumesUse && usedCount >= token.maxUses) {
      data['status'] = RightsAgentTokenStatus.USED;
    }

    await this.tokenDelegate.update({ where: { id: tokenId }, data });
  }

  async touchUsage(tokenId: string, ip: string | null, userAgent: string | null): Promise<void> {
    await this.tokenDelegate.update({
      where: { id: tokenId },
      data: { lastUsedIp: ip, lastUsedUserAgent: userAgent },
    });
  }

  private toDto(record: RightsAgentUploadTokenRecord): AgentTokenDto {
    const isExpired = new Date(record.expiresAt).getTime() <= Date.now();
    const remainingUses = Math.max(0, record.maxUses - record.usedCount);
    return {
      id: record.id,
      rightsIntakeId: record.rightsIntakeId,
      tokenPrefix: record.tokenPrefix,
      status: record.status,
      labelRu: record.labelRu,
      maxUses: record.maxUses,
      usedCount: record.usedCount,
      remainingUses,
      failedAttempts: record.failedAttempts,
      maxFailedAttempts: record.maxFailedAttempts,
      allowRetryOnValidationError: record.allowRetryOnValidationError,
      autoMaterialize: record.autoMaterialize,
      allowedSchemaVersions: toStringArray(record.allowedSchemaVersions),
      expiresAt: new Date(record.expiresAt).toISOString(),
      isExpired,
      isUsable:
        record.status === RightsAgentTokenStatus.ACTIVE &&
        !isExpired &&
        record.usedCount < record.maxUses &&
        record.failedAttempts < record.maxFailedAttempts,
      issuedByUserId: record.issuedByUserId,
      firstUsedAt: record.firstUsedAt ? new Date(record.firstUsedAt).toISOString() : null,
      lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
      revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null,
      revokeReasonRu: record.revokeReasonRu,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    };
  }
}
