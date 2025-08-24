import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly maxPoints: number;
  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {
    // parse limits with defaults
    const rawWindow = this.config.get<string>('RATE_LIMIT_COMMENTS_WINDOW_MS');
    const rawMax = this.config.get<string>('RATE_LIMIT_COMMENTS_PER_MINUTE');
    const windowParsed = rawWindow ? Number(rawWindow) : NaN;
    const maxParsed = rawMax ? Number(rawMax) : NaN;
    this.windowMs = Number.isFinite(windowParsed) && windowParsed > 0 ? windowParsed : 60_000;
    // keep backward-compat: name says per minute, but works with any windowMs
    this.maxPoints = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : 10;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const enabled = this.config.get('RATE_LIMIT_ENABLED') === '1';
    if (!enabled) return true;
    const req = context.switchToHttp().getRequest<{ user?: { userId: string }; ip: string }>();
    const userKey = req.user?.userId ?? req.ip;
    // 1 point per action, window/max from env
    const ok = await this.rateLimiter.consume(
      `comments:${userKey}`,
      1,
      this.windowMs,
      this.maxPoints,
    );
    if (!ok) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
