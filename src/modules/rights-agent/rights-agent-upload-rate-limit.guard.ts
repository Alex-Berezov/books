import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';
import { AGENT_ERROR_CODES, AGENT_ERROR_MESSAGES_RU } from './rights-agent.constants';

/**
 * Per-IP rate limit for the public agent endpoints. Runs before `RightsAgentTokenGuard`
 * so unauthenticated floods are cut off before any database lookup.
 *
 * Environment Variables:
 * - RATE_LIMIT_AGENT_UPLOAD_ENABLED: Enable limits (0/1), default 1
 * - RATE_LIMIT_AGENT_UPLOAD_MAX: Requests per window, default 20
 * - RATE_LIMIT_AGENT_UPLOAD_WINDOW_MS: Window length in ms, default 3600000 (1 hour)
 */
@Injectable()
export class RightsAgentUploadRateLimitGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly maxPoints: number;
  private readonly windowMs: number;

  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {
    this.enabled = (this.config.get('RATE_LIMIT_AGENT_UPLOAD_ENABLED') ?? '1') === '1';

    const max = Number(this.config.get('RATE_LIMIT_AGENT_UPLOAD_MAX'));
    this.maxPoints = Number.isFinite(max) && max > 0 ? max : 20;

    const window = Number(this.config.get('RATE_LIMIT_AGENT_UPLOAD_WINDOW_MS'));
    this.windowMs = Number.isFinite(window) && window > 0 ? window : 3_600_000;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const req = context.switchToHttp().getRequest<{ ip?: string }>();
    const key = `agent-upload:ip:${req.ip ?? 'unknown'}`;

    const ok = await this.rateLimiter.consume(key, 1, this.windowMs, this.maxPoints);
    if (!ok) {
      const retryAfter = Math.ceil(this.windowMs / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: AGENT_ERROR_CODES.AGENT_UPLOAD_RATE_LIMITED,
          message: 'Too many agent upload requests. Please try again later.',
          messageRu: AGENT_ERROR_MESSAGES_RU.AGENT_UPLOAD_RATE_LIMITED,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
