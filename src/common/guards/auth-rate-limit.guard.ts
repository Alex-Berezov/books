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

/**
 * Auth Rate Limit Guard
 *
 * Применяет строгие лимиты для auth endpoints для защиты от брутфорса
 *
 * Environment Variables:
 * - RATE_LIMIT_AUTH_ENABLED: Включить лимиты (0/1), по умолчанию 1
 * - RATE_LIMIT_LOGIN_MAX: Максимальное количество попыток логина, по умолчанию 5
 * - RATE_LIMIT_LOGIN_WINDOW_MS: Окно для лимита логина, по умолчанию 60000 (1 мин)
 * - RATE_LIMIT_REGISTER_MAX: Максимальное количество регистраций, по умолчанию 3
 * - RATE_LIMIT_REGISTER_WINDOW_MS: Окно для лимита регистрации, по умолчанию 300000 (5 мин)
 * - RATE_LIMIT_REFRESH_MAX: Максимальное количество обновлений токена, по умолчанию 10
 * - RATE_LIMIT_REFRESH_WINDOW_MS: Окно для лимита обновления токена, по умолчанию 60000 (1 мин)
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
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ ip: string; path?: string; originalUrl?: string; body?: { email?: string } }>();

    const path = req.path || req.originalUrl || '';
    const email = req.body?.email || '';

    // Определяем тип операции и применяем соответствующие лимиты
    let operation: 'login' | 'register' | 'refresh' | null = null;
    let maxPoints: number;
    let windowMs: number;
    let key: string;

    if (path.includes('/login')) {
      operation = 'login';
      maxPoints = this.loginMax;
      windowMs = this.loginWindowMs;
      // Ключ: IP + email (если указан) для более точного отслеживания брутфорса
      key = email ? `auth:login:${req.ip}:${email}` : `auth:login:${req.ip}`;
    } else if (path.includes('/register')) {
      operation = 'register';
      maxPoints = this.registerMax;
      windowMs = this.registerWindowMs;
      // Ключ: IP для предотвращения спама регистраций
      key = `auth:register:${req.ip}`;
    } else if (path.includes('/refresh')) {
      operation = 'refresh';
      maxPoints = this.refreshMax;
      windowMs = this.refreshWindowMs;
      // Ключ: IP для refresh токена
      key = `auth:refresh:${req.ip}`;
    } else {
      // Неизвестный endpoint - пропускаем
      return true;
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
