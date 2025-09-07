import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';

/**
 * Глобальный фильтр исключений, который отправляет 5xx ошибки в Sentry.
 * 4xx (400/401/403/404/429) умышленно игнорируются, чтобы не шуметь.
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
              scope.setTag('method', method);
              scope.setTag('route', routePath ?? path ?? 'unknown');
              scope.setTag('status_code', String(status));
              scope.setContext('request', {
                url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
                method,
                headers: req.headers,
                query: req.query,
                params: req.params,
                body: this.safeBody(req.body),
                ip: req.ip,
              });
              // Optional lightweight breadcrumbs for request timeline
              const breadcrumbs = [
                { category: 'http', level: 'info', message: `${method} ${req.originalUrl}` },
                { category: 'http', level: 'error', message: `→ ${status}` },
              ] as const;
              scope.addBreadcrumb(breadcrumbs[0]);
              scope.addBreadcrumb(breadcrumbs[1]);
              const user = this.getUser(req);
              if (user?.id) {
                scope.setUser({ id: String(user.id), email: user.email });
              }
            }
            Sentry.captureException(exception);
          });
        }
      }
    } catch (e) {
      // Никогда не ломаем обработку исключений из-за проблем с Sentry
      this.logger.debug(`Sentry capture failed: ${String(e)}`);
    }

    // Продолжаем стандартную обработку Nest
    return super.catch(exception, host);
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private safeBody(body: unknown): unknown {
    if (!this.isPlainObject(body)) return body;
    const src = body;
    const clone: Record<string, unknown> = { ...src };
    // Маскируем потенциально чувствительные поля
    for (const key of Object.keys(clone)) {
      if (/password|token|authorization|secret|cookie/i.test(key)) {
        clone[key] = '[Filtered]';
      }
    }
    return clone;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getRoutePath(req: Request): string | undefined {
    // Express добавляет route.path на объект req; тайпинги этого не включают
    const maybeWithRoute = req as unknown as { route?: { path?: unknown } };
    const p = maybeWithRoute.route?.path;
    return typeof p === 'string' ? p : undefined;
  }

  private getUser(req: Request): { id?: string | number; email?: string } | undefined {
    const r = req as Request & { user?: { id?: string | number; email?: string } };
    return r.user;
  }
}
