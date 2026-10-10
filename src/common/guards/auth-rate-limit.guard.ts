import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIPv6 } from 'node:net';
import {
  describeClientIp,
  parseInternalProxyCidrs,
  parseTrustedProxyCidrs,
} from '../net/client-ip';
import { RATE_LIMITER, RateLimiter } from '../../shared/rate-limit/rate-limit.interface';
import { unverifiedTokenSubject } from '../../shared/session/session-token';
import { normalizeEmail } from '../../shared/validators/normalize-email.decorator';

/**
 * Потолок выходов с одного адреса в окне (`LEGACY-451`, решение арбитра 10.10.2026). Выше
 * обычного лимита: с сайта все выходы идут с адреса сервера Next. Держит корзины по `sub`
 * от подделки — новый `sub` даёт новую корзину пользователя, но не новый потолок адреса.
 */
export const LOGOUT_IP_MAX = 60;

/**
 * Потолок попыток входа с одного адреса по всем почтам в окне входа — в узких корзинах
 * `ip + email` (`LEGACY-453`). Узкая корзина держит перебор паролей одного аккаунта, но не перебор
 * многих аккаунтов одним паролем: каждый новый адрес почты получал свою. Выше узкой — за одним
 * адресом бывает несколько человек (офис, NAT оператора). Множитель, а не число: при своём
 * `RATE_LIMIT_LOGIN_MAX` потолок адреса иначе оказался бы строже узкой корзины.
 */
export const LOGIN_IP_BUCKETS = 4;

/**
 * Корзина аккаунта по всем адресам в окне входа — против распределённого перебора (`LEGACY-453`,
 * решение арбитра 11.10.2026), в узких корзинах.
 *
 * ⚠️ Мягкая намеренно: её можно выбрать чужими запросами и запереть вход владельцу. Поэтому окно
 * то же, что у узкой корзины `ip + email`, а потолок — шесть таких корзин: один адрес даёт не
 * больше двух узких корзин за окно (окна фиксированные и сдвинуты), то есть с одного адреса её
 * не выбрать. Множитель, а не число — по той же причине: при своём `RATE_LIMIT_LOGIN_MAX` число
 * снова выбиралось бы одним адресом. Цена при умолчаниях: распределённый перебор — до 30 попыток
 * в минуту на аккаунт (~43 тыс. в сутки); шесть и более адресов держат вход паролем закрытым,
 * пока шлют запросы, и блокировка снимается через окно после остановки.
 */
export const LOGIN_ACCOUNT_BUCKETS = 6;

/**
 * Адрес как ключ корзин входа: IPv6 — по сети /64, а не по адресу (`LEGACY-453`). Провайдеры
 * и хостеры раздают клиенту целую /64, и счёт по точному адресу давал бы каждому запросу из неё
 * свежие корзины — ни потолок адреса, ни «с одного адреса аккаунт не запереть» не держались бы.
 * IPv4 и всё, что не разбирается как IPv6, — как есть.
 */
export function loginLimitSubject(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

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
  private readonly internalCidrs: string[];

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

    // Catch-all limits for every other route under /auth (today: /social; /logout has its own buckets).
    const defaultMax = Number(this.config.get('RATE_LIMIT_AUTH_DEFAULT_MAX'));
    const defaultWindow = Number(this.config.get('RATE_LIMIT_AUTH_DEFAULT_WINDOW_MS'));
    this.defaultMax = Number.isFinite(defaultMax) && defaultMax > 0 ? defaultMax : 10;
    this.defaultWindowMs =
      Number.isFinite(defaultWindow) && defaultWindow > 0 ? defaultWindow : 60_000;
    this.trustedCidrs = parseTrustedProxyCidrs(this.config.get<string>('TRUSTED_PROXY_CIDRS'));
    this.internalCidrs = parseInternalProxyCidrs(this.config.get<string>('INTERNAL_PROXY_CIDRS'));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const req = context.switchToHttp().getRequest<{
      ip: string;
      path?: string;
      originalUrl?: string;
      body?: { email?: string; refreshToken?: unknown };
      headers?: Record<string, string | string[] | undefined>;
    }>();

    const path = req.path || req.originalUrl || '';
    // Ключ по той же форме адреса, что ищет вход (LEGACY-443): иначе `Victim@x.com`, `vIctim@x.com`
    // и прочие варианты регистра получали бы по своей корзине на один и тот же аккаунт.
    const rawEmail = req.body?.email;
    const email = typeof rawEmail === 'string' ? (normalizeEmail(rawEmail) as string) : '';
    // Тот же адрес, что и у глобального лимитера: за Cloudflare `req.ip` — это узел
    // CF, и без этой замены пять попыток входа делили бы все посетители одного PoP.
    // Чужие неудачные входы блокировали бы вход человеку, который ничего не делал.
    const client = describeClientIp(req, this.trustedCidrs, this.internalCidrs);
    const clientIp = client.ip;

    // Determine operation type and apply matching limits
    let operation: 'login' | 'register' | 'refresh' | 'auth';
    let maxPoints: number;
    let windowMs: number;
    let key: string;

    if (path.includes('/login')) {
      operation = 'login';
      maxPoints = this.loginMax;
      windowMs = this.loginWindowMs;
      const subject = loginLimitSubject(clientIp);
      // Три корзины по порядку от узкой к широкой (`LEGACY-453`); отказ узкой не тратит широкие —
      // иначе один адрес, упёршийся в свою корзину, продолжал бы выбирать корзину аккаунта.
      key = email ? `auth:login:${subject}:${email}` : `auth:login:${subject}`;
      await this.consumeOrRefuse(key, windowMs, maxPoints, operation);
      // Вход с сервера Next без адреса посетителя — это все посетители сразу (`LEGACY-064`):
      // общая корзина адреса заперла бы вход всему сайту. Узкая и аккаунта остаются.
      if (!client.internalWithoutVisitor) {
        await this.consumeOrRefuse(
          `auth:login-ip:${subject}`,
          windowMs,
          maxPoints * LOGIN_IP_BUCKETS,
          operation,
        );
      }
      if (email) {
        await this.consumeOrRefuse(
          `auth:login-account:${email}`,
          windowMs,
          maxPoints * LOGIN_ACCOUNT_BUCKETS,
          operation,
        );
      }
      return true;
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
    } else if (path.includes('/logout')) {
      // Выход гасит все сессии пользователя (`LEGACY-451`) и с сайта идёт с сервера Next, без
      // адреса посетителя: в общей корзине `auth:other` выходы всего сайта делили бы лимит
      // соцвхода, и выход молча не гасил бы сессии. Две корзины подряд (решение арбитра
      // 10.10.2026): адрес с потолком `LOGOUT_IP_MAX` и адрес плюс `sub` из тела с обычным
      // лимитом. `sub` берётся без проверки подписи — это только ключ, подпись проверяет
      // сервис; подделка `sub` даёт новую вторую корзину, но упирается в первую.
      operation = 'auth';
      maxPoints = this.defaultMax;
      windowMs = this.defaultWindowMs;
      key = `auth:logout:${clientIp}:${unverifiedTokenSubject(req.body?.refreshToken)}`;
      const ipOk = await this.rateLimiter.consume(
        `auth:logout:${clientIp}`,
        1,
        windowMs,
        LOGOUT_IP_MAX,
      );
      if (!ipOk) this.refuse(operation, windowMs);
    } else {
      // Every other route under /auth — today /social, tomorrow
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
    if (!ok) this.refuse(operation, windowMs);

    return true;
  }

  private async consumeOrRefuse(
    key: string,
    windowMs: number,
    maxPoints: number,
    operation: string,
  ): Promise<void> {
    if (!(await this.rateLimiter.consume(key, 1, windowMs, maxPoints))) {
      this.refuse(operation, windowMs);
    }
  }

  private refuse(operation: string, windowMs: number): never {
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
}
