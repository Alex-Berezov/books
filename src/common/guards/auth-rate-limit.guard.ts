import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseTrustedProxyCidrs, resolveClientIp } from '../net/client-ip';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

/**
 * Auth Rate Limit Guard
 *
 * Applies strict rate limits for auth endpoints to protect against brute force.
 *
 * Environment Variables:
 * - RATE_LIMIT_AUTH_ENABLED: Enable limits (0/1), default 1
 * - RATE_LIMIT_LOGIN_MAX: Max login attempts, default 5
 * - RATE_LIMIT_LOGIN_WINDOW_MS: Login limit window, default 60000 (1 min)
 * - RATE_LIMIT_REGISTER_MAX: Max registrations, default 3
 * - RATE_LIMIT_REGISTER_WINDOW_MS: Registration limit window, default 300000 (5 min)
 * - RATE_LIMIT_REFRESH_MAX: Max token refresh operations, default 10
 * - RATE_LIMIT_REFRESH_WINDOW_MS: Refresh limit window, default 60000 (1 min)
 * - RATE_LIMIT_AUTH_DEFAULT_MAX: Max requests to any other auth route, default 10
 * - RATE_LIMIT_AUTH_DEFAULT_WINDOW_MS: Window for those, default 60000 (1 min)
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly loginMax: number;
  private readonly loginWindowMs: number;
  private readonly registerMax: number;
  private readonly registerWindowMs: number;
  private readonly refreshMax: number;
  private readonly refreshWindowMs: number;
  private readonly defaultMax: number;
  private readonly defaultWindowMs: number;
  private readonly trustedCidrs: string[];

  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {
    this.enabled = (this.config.get('RATE_LIMIT_AUTH_ENABLED') ?? '1') === '1';

    // Login limits
    const loginMax = Number(this.config.get('RATE_LIMIT_LOGIN_MAX'));
    const loginWindow = Number(this.config.get('RATE_LIMIT_LOGIN_WINDOW_MS'));
    this.loginMax = Number.isFinite(loginMax) && loginMax > 0 ? loginMax : 5;
    this.loginWindowMs = Number.isFinite(loginWindow) && loginWindow > 0 ? loginWindow : 60_000;

    // Register limits
    const registerMax = Number(this.config.get('RATE_LIMIT_REGISTER_MAX'));
    const registerWindow = Number(this.config.get('RATE_LIMIT_REGISTER_WINDOW_MS'));
    this.registerMax = Number.isFinite(registerMax) && registerMax > 0 ? registerMax : 3;
    this.registerWindowMs =
      Number.isFinite(registerWindow) && registerWindow > 0 ? registerWindow : 300_000;

    // Refresh limits
    const refreshMax = Number(this.config.get('RATE_LIMIT_REFRESH_MAX'));
    const refreshWindow = Number(this.config.get('RATE_LIMIT_REFRESH_WINDOW_MS'));
    this.refreshMax = Number.isFinite(refreshMax) && refreshMax > 0 ? refreshMax : 10;
    this.refreshWindowMs =
      Number.isFinite(refreshWindow) && refreshWindow > 0 ? refreshWindow : 60_000;

    // Catch-all limits for every other route under /auth (today: /social, /logout).
    const defaultMax = Number(this.config.get('RATE_LIMIT_AUTH_DEFAULT_MAX'));
    const defaultWindow = Number(this.config.get('RATE_LIMIT_AUTH_DEFAULT_WINDOW_MS'));
    this.defaultMax = Number.isFinite(defaultMax) && defaultMax > 0 ? defaultMax : 10;
    this.defaultWindowMs =
      Number.isFinite(defaultWindow) && defaultWindow > 0 ? defaultWindow : 60_000;
    this.trustedCidrs = parseTrustedProxyCidrs(this.config.get<string>('TRUSTED_PROXY_CIDRS'));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const req = context.switchToHttp().getRequest<{
      ip: string;
      path?: string;
      originalUrl?: string;
      body?: { email?: string };
      headers?: Record<string, string | string[] | undefined>;
    }>();

    const path = req.path || req.originalUrl || '';
    const email = req.body?.email || '';
    // Тот же адрес, что и у глобального лимитера: за Cloudflare `req.ip` — это узел
    // CF, и без этой замены пять попыток входа делили бы все посетители одного PoP.
    // Чужие неудачные входы блокировали бы вход человеку, который ничего не делал.
    const clientIp = resolveClientIp(req, this.trustedCidrs);

    // Determine operation type and apply matching limits
    let operation: 'login' | 'register' | 'refresh' | 'auth';
    let maxPoints: number;
    let windowMs: number;
    let key: string;

    if (path.includes('/login')) {
      operation = 'login';
      maxPoints = this.loginMax;
      windowMs = this.loginWindowMs;
      // Key: IP + email (if present) for finer brute-force detection
      key = email ? `auth:login:${clientIp}:${email}` : `auth:login:${clientIp}`;
    } else if (path.includes('/register')) {
      operation = 'register';
      maxPoints = this.registerMax;
      windowMs = this.registerWindowMs;
      // Key: IP to prevent registration spam
      key = `auth:register:${clientIp}`;
    } else if (path.includes('/refresh')) {
      operation = 'refresh';
      maxPoints = this.refreshMax;
      windowMs = this.refreshWindowMs;
      // Key: IP for refresh token operations
      key = `auth:refresh:${clientIp}`;
    } else {
      // Every other route under /auth — today /social and /logout, tomorrow
      // whatever gets added. Returning `true` here meant a new auth route was
      // unlimited until someone remembered to add a branch: the default was
      // "allow", the same shape as "no robots directive → index". The default
      // is now "count it".
      operation = 'auth';
      maxPoints = this.defaultMax;
      windowMs = this.defaultWindowMs;
      // Keyed by IP alone. Putting the path in the key would hand out a fresh
      // budget for every made-up path under /auth.
      key = `auth:other:${clientIp}`;
    }

    const ok = await this.rateLimiter.consume(key, 1, windowMs, maxPoints);

    if (!ok) {
      const retryAfter = Math.ceil(windowMs / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many ${operation} attempts. Please try again later.`,
          error: 'Too Many Requests',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
