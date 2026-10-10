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
import {
  describeClientIp,
  parseInternalProxyCidrs,
  parseTrustedProxyCidrs,
} from '../net/client-ip';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { readRolesCacheTtlMs } from '../roles/roles-cache';
import { hasModeratorRole } from '../roles/moderator-roles.service';
import { readSessionState } from '../../shared/session/session-state-reader';
import { isSessionAlive, type SessionTokenClaims } from '../../shared/session/session-token';

@Injectable()
export class GlobalRateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly maxPoints: number;
  private readonly trustedCidrs: string[];
  private readonly internalCidrs: string[];
  private readonly ttlMs: number;

  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {
    this.ttlMs = readRolesCacheTtlMs(this.config.get<string>('ROLES_CACHE_TTL_MS'));
    const rawWindow = this.config.get<string>('RATE_LIMIT_GLOBAL_WINDOW_MS');
    const rawMax = this.config.get<string>('RATE_LIMIT_GLOBAL_MAX');
    const windowParsed = rawWindow ? Number(rawWindow) : NaN;
    const maxParsed = rawMax ? Number(rawMax) : NaN;
    this.windowMs = Number.isFinite(windowParsed) && windowParsed > 0 ? windowParsed : 60_000;
    this.maxPoints = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : 100;
    this.trustedCidrs = parseTrustedProxyCidrs(this.config.get<string>('TRUSTED_PROXY_CIDRS'));
    this.internalCidrs = parseInternalProxyCidrs(this.config.get<string>('INTERNAL_PROXY_CIDRS'));
  }

  /**
   * Сбой проверки — не обход и не отказ: токен, который не удалось сверить (подпись, нет секрета,
   * база не ответила), считается в лимит как анонимный запрос. Иначе сбой базы ронял бы 500
   * каждый запрос модератора на любом маршруте, в том числе публичном.
   */
  private async isLiveModeratorToken(authHeader: string | undefined): Promise<boolean> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.split(' ')[1];
    try {
      const secret = requireJwtAccessSecret((key) => this.config.get<string>(key));
      const payload = this.jwtService.verify<SessionTokenClaims & { roles?: unknown }>(token, {
        secret,
      });
      const roles = new Set(Array.isArray(payload.roles) ? payload.roles.map(String) : []);
      if (!hasModeratorRole(roles)) return false;
      return isSessionAlive(await readSessionState(this.prisma, payload.sub, this.ttlMs), payload);
    } catch {
      return false;
    }
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

    const client = describeClientIp(req, this.trustedCidrs, this.internalCidrs);

    // Рендер страницы: наш собственный SSR, за которым стоят все посетители сразу.
    // Считать это одной корзиной — значит выдать всему сайту 100 запросов в минуту
    // и ронять его собственными руками (LEGACY-064). Ограничение для посетителей
    // живёт на входе перед фронтом, где виден настоящий клиент; здесь оно только
    // мешало бы. Запросы фронта, которые **сообщают** посетителя (вход в аккаунт),
    // сюда не попадают и считаются как обычно.
    if (client.internalWithoutVisitor) return true;

    // Модератор обходит лимит — но только живой сессией (`LEGACY-453`): подписи мало, погашенный
    // токен (выход, пароль, роли, блокировка) иначе оставался без лимита до конца своего срока
    // на маршрутах, которые `JwtStrategy` не проходят. Сверка та же, что у неё (`LEGACY-451`, `452`).
    // После дешёвых пропусков: проверке нужна база, а health и рендер страниц её не ждут.
    if (await this.isLiveModeratorToken(req.headers.authorization)) return true;

    const key = `global:${client.ip}`;
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
