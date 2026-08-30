import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';
import { redactKeys, redactUrl } from './redact.util';

/**
 * Global exception filter that reports 5xx errors to Sentry.
 * 4xx (400/401/403/404/429) are deliberately ignored to reduce noise.
 *
 * ⚠️ Маска значений живёт в `redact.util.ts` (`LEGACY-331`). Любое новое поле
 * контекста события обязано проходить через `redactKeys` — это правило
 * `LEGACY-115`; вызовы со своим набором полей (`setUser`, `setTag`,
 * `addBreadcrumb`) редактор не покрывает и решаются глазами.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(SentryExceptionFilter.name);
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly enabled: boolean,
  ) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost) {
    try {
      if (this.enabled) {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<Request>();

        const status = this.getStatus(exception);
        const isServerError = status >= 500;
        const isIgnoredClientError = [
          HttpStatus.BAD_REQUEST,
          HttpStatus.UNAUTHORIZED,
          HttpStatus.FORBIDDEN,
          HttpStatus.NOT_FOUND,
          HttpStatus.TOO_MANY_REQUESTS,
        ].includes(status);

        if (isServerError && !isIgnoredClientError) {
          Sentry.withScope((scope) => {
            if (req) {
              const { method, path } = req;
              const routePath = this.getRoutePath(req);
              const safeUrl = redactUrl(req.originalUrl);
              scope.setTag('method', method);
              scope.setTag('route', routePath ?? path ?? 'unknown');
              scope.setTag('status_code', String(status));
              scope.setContext('request', {
                url: `${req.protocol}://${req.get('host')}${safeUrl}`,
                method,
                headers: redactKeys(req.headers),
                query: redactKeys(req.query),
                params: redactKeys(req.params),
                body: redactKeys(req.body),
                ip: req.ip,
              });
              // Optional lightweight breadcrumbs for request timeline
              const breadcrumbs = [
                { category: 'http', level: 'info', message: `${method} ${safeUrl}` },
                { category: 'http', level: 'error', message: `→ ${status}` },
              ] as const;
              scope.addBreadcrumb(breadcrumbs[0]);
              scope.addBreadcrumb(breadcrumbs[1]);
              const user = this.getUser(req);
              if (user?.userId) {
                scope.setUser({ id: String(user.userId) });
              }
            }
            Sentry.captureException(exception);
          });
        }
      }
    } catch (e) {
      // Never break exception handling due to Sentry issues
      this.logger.debug(`Sentry capture failed: ${String(e)}`);
    }

    // Continue standard Nest exception handling
    return super.catch(exception, host);
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private getRoutePath(req: Request): string | undefined {
    // Express adds route.path to req; types do not expose it
    const maybeWithRoute = req as unknown as { route?: { path?: unknown } };
    const p = maybeWithRoute.route?.path;
    return typeof p === 'string' ? p : undefined;
  }

  /**
   * Пользователь запроса для атрибуции события (`LEGACY-187`).
   *
   * 🔴 Тип сужен до одного поля намеренно. До 30.08.2026 здесь стояло `id`,
   * а единственная стратегия (`auth/strategies/jwt.strategy.ts`) кладёт
   * в запрос `userId` — как и весь остальной код (`roles.guard.ts`,
   * `rate-limit.guard.ts`, `moderator-roles.service.ts`). Из-за расхождения
   * ветка `setUser` не срабатывала ни разу, и события уходили без атрибуции
   * вовсе. Отсутствие `email` в типе — тоже часть правки: вернуть почту
   * случайным `user.email` в этот вызов теперь нельзя.
   * Решение арбитра от 30.08.2026.
   */
  private getUser(req: Request): { userId?: string } | undefined {
    const r = req as Request & { user?: { userId?: string } };
    return r.user;
  }
}
