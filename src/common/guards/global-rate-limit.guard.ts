import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { requireJwtAccessSecret } from '../config/jwt-secrets';
import { parseTrustedProxyCidrs, resolveClientIp } from '../net/client-ip';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly maxPoints: number;
  private readonly trustedCidrs: string[];

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
    this.trustedCidrs = parseTrustedProxyCidrs(this.config.get<string>('TRUSTED_PROXY_CIDRS'));
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
        const secret = requireJwtAccessSecret((key) => this.config.get<string>(key));
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

    // Skip health and swagger endpoints.
    //
    // `/metrics` used to be skipped too, which meant an anonymous client could
    // poll it at any rate. Every request there also creates label series in the
    // prom-client registry, so an unlimited route is a memory-growth vector and
    // not merely a noisy one. Health stays skipped on purpose: the deploy wait
    // and the container probe poll it, and starving those breaks deployments.
    if (
      path.startsWith('/health') ||
      path.startsWith('/api/health') ||
      path.startsWith('/api/docs') ||
      path.startsWith('/api/docs-json')
    ) {
      return true;
    }

    const key = `global:${resolveClientIp(req, this.trustedCidrs)}`;
    const ok = await this.rateLimiter.consume(key, 1, this.windowMs, this.maxPoints);
    if (ok) return true;

    // Раньше гвард возвращал `false`, и Nest превращал это в 403. Разница не
    // косметическая: 403 читается клиентом и роботом как «тебе сюда нельзя»
    // (Googlebot по такому ответу снижает частоту обхода надолго), а 429 —
    // как «повтори позже». `Retry-After` даёт срок, вместо того чтобы заставлять
    // угадывать (LEGACY-064).
    const retryAfterSeconds = Math.ceil(this.windowMs / 1000);
    const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    res.header?.('Retry-After', String(retryAfterSeconds));

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests. Please try again later.',
        error: 'Too Many Requests',
        retryAfter: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
