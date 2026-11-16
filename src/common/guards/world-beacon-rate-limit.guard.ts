import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  describeClientIp,
  parseInternalProxyCidrs,
  parseTrustedProxyCidrs,
  type ClientIpRequest,
} from '../net/client-ip';
import { isBotUserAgent } from '../../shared/http/bot-user-agent';
import { RATE_LIMITER, type RateLimiter } from '../../shared/rate-limit/rate-limit.interface';

/** Событий с одного адреса в минуту: страница шлёт `view` и пару переходов, запас — на вкладки. */
export const WORLD_BEACON_LIMIT = { points: 60, windowMs: 60_000 } as const;

/**
 * Ключ ограничителя без сырого адреса: хэш IP с префиксом ручки. Ограничитель держит ключ в памяти
 * процесса на окно, в базу и журнал адрес не попадает (`product.md` §14 F08).
 */
export function worldBeaconLimitKey(ip: string): string {
  return `world-beacon:${createHash('sha256').update(ip).digest('hex').slice(0, 32)}`;
}

/**
 * Лимит приёмника счётчиков мира книги (`POST /world/beacon`, F08-3a): по адресу посетителя
 * (`describeClientIp`: за прокси фронта — `X-Visitor-IP`), до проверки тела `ValidationPipe`. Бот лимит
 * не тратит — его событие сервис не пишет; сервер фронта без адреса посетителя — тоже. Сверх лимита — 429 с `Retry-After`, как у `GlobalRateLimitGuard`.
 */
@Injectable()
export class WorldBeaconRateLimitGuard implements CanActivate {
  private readonly trustedCidrs: string[];
  private readonly internalCidrs: string[];

  constructor(
    config: ConfigService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {
    this.trustedCidrs = parseTrustedProxyCidrs(config.get<string>('TRUSTED_PROXY_CIDRS'));
    this.internalCidrs = parseInternalProxyCidrs(config.get<string>('INTERNAL_PROXY_CIDRS'));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ClientIpRequest>();
    const ua = req.headers?.['user-agent'];
    if (isBotUserAgent(Array.isArray(ua) ? ua[0] : ua)) return true;
    const client = describeClientIp(req, this.trustedCidrs, this.internalCidrs);
    // Собственный сервер фронта без `X-Visitor-IP`: адрес — его, а не посетителя. Считать его одной
    // корзиной — дать всему сайту 60 событий в минуту (`LEGACY-064`, как у `GlobalRateLimitGuard`).
    if (client.internalWithoutVisitor) return true;
    const { points, windowMs } = WORLD_BEACON_LIMIT;
    if (await this.limiter.consume(worldBeaconLimitKey(client.ip), 1, windowMs, points))
      return true;
    const retryAfter = Math.ceil(windowMs / 1000);
    const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    res.header?.('Retry-After', String(retryAfter));
    // Тело — той же формы, что у `GlobalRateLimitGuard`: клиент читает `retryAfter` одинаково.
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests. Please try again later.',
        error: 'Too Many Requests',
        retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
