import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly maxPoints: number;

  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    private readonly jwtService: JwtService,
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

    const req = context.switchToHttp().getRequest<{
      ip: string;
      path?: string;
      originalUrl?: string;
      headers: Record<string, string | undefined>;
    }>();
    const path = req.path || req.originalUrl || '';

    // Check for admin token to bypass rate limit
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const secret = this.config.get<string>('JWT_ACCESS_SECRET') || 'dev_access_secret';
        const payload = this.jwtService.verify<{ roles?: string[] }>(token, { secret });
        if (
          payload.roles &&
          Array.isArray(payload.roles) &&
          (payload.roles.includes('admin') || payload.roles.includes('content_manager'))
        ) {
          return true;
        }
      } catch {
        // Ignore invalid tokens
      }
    }

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
