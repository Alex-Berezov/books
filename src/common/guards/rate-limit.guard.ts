import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const enabled = this.config.get('RATE_LIMIT_ENABLED') === '1';
    if (!enabled) return true;
    const req = context.switchToHttp().getRequest<{ user?: { userId: string }; ip: string }>();
    const userKey = req.user?.userId ?? req.ip;
    // 10 points per minute default
    const ok = await this.rateLimiter.consume(`comments:${userKey}`, 1, 60_000, 10);
    return ok;
  }
}
