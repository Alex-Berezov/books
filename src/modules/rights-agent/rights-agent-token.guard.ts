import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RightsAgentTokenService } from './rights-agent-token.service';
import {
  AGENT_ERROR_CODES,
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_PREFIX,
} from './rights-agent.constants';
import { agentError } from './rights-agent.errors';
import { toStringArray, type AgentTokenRequestContext } from './rights-agent-interface';

/** Request shape the guard reads and augments, typed locally to avoid `any`. */
export interface AgentRequest {
  agentToken?: AgentTokenRequestContext;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Authenticates the external clearance agent by its one-time upload token.
 * This guard never grants access to admin data — only to the intake bound to the token.
 */
@Injectable()
export class RightsAgentTokenGuard implements CanActivate {
  constructor(
    private readonly tokenService: RightsAgentTokenService,
    private readonly config: ConfigService,
  ) {}

  private get uploadEnabled(): boolean {
    return (this.config.get('RIGHTS_AGENT_UPLOAD_ENABLED') ?? '1') === '1';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.uploadEnabled) {
      throw agentError(HttpStatus.SERVICE_UNAVAILABLE, AGENT_ERROR_CODES.AGENT_UPLOAD_DISABLED);
    }

    const req = context.switchToHttp().getRequest<AgentRequest>();
    const raw = this.extractToken(req);
    if (!raw) {
      throw agentError(HttpStatus.UNAUTHORIZED, AGENT_ERROR_CODES.AGENT_TOKEN_MISSING);
    }

    const resolution = await this.tokenService.resolveForRequest(raw);
    if (!resolution.ok) {
      throw agentError(
        HttpStatus.UNAUTHORIZED,
        resolution.code as (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES],
      );
    }

    req.agentToken = {
      tokenId: resolution.token.id,
      rightsIntakeId: resolution.token.rightsIntakeId,
      allowedSchemaVersions: toStringArray(resolution.token.allowedSchemaVersions),
      autoMaterialize: resolution.token.autoMaterialize,
      allowRetryOnValidationError: resolution.token.allowRetryOnValidationError,
    };

    return true;
  }

  /**
   * Reads the dedicated header first. `Authorization: Bearer …` is only accepted when the
   * value carries the agent-token prefix — a user JWT must never be treated as an agent token.
   */
  private extractToken(req: AgentRequest): string | null {
    const headerValue = req.headers[AGENT_TOKEN_HEADER];
    const direct = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof direct === 'string' && direct.trim() !== '') {
      return direct.trim();
    }

    const authValue = req.headers['authorization'];
    const auth = Array.isArray(authValue) ? authValue[0] : authValue;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const candidate = auth.slice('Bearer '.length).trim();
      if (candidate.startsWith(AGENT_TOKEN_PREFIX)) {
        return candidate;
      }
    }

    return null;
  }
}
