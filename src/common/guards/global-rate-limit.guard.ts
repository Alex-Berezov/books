import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly maxPoints: number;

  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {
    const rawWindow = this.config.get<string>('RATE_LIMIT_GLOBAL_WINDOW_MS');
    const rawMax = this.config.get<string>('RATE_LIMIT_GLOBAL_MAX');
    const windowParsed = rawWindow ? Number(rawWindow) : NaN;
    const maxParsed = rawMax ? Number(rawMax) : NaN;
    this.windowMs = Number.isFinite(windowParsed) && windowParsed > 0 ? windowParsed : 60_000;
    this.maxPoints = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : 100;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const enabled = this.config.get('RATE_LIMIT_GLOBAL_ENABLED') === '1';
    if (!enabled) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ ip: string; path?: string; originalUrl?: string }>();
    const path = req.path || req.originalUrl || '';
    // Skip health/metrics and swagger endpoints
    if (
      path.startsWith('/metrics') ||
      path.startsWith('/health') ||
      path.startsWith('/api/metrics') ||
      path.startsWith('/api/health') ||
      path.startsWith('/api/docs') ||
      path.startsWith('/api/docs-json')
    ) {
      return true;
    }

    const key = `global:${req.ip}`;
    const ok = await this.rateLimiter.consume(key, 1, this.windowMs, this.maxPoints);
    return ok;
  }
}
