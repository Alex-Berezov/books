import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';

/**
 * Ключи, значения которых не уезжают во внешний сервис (`LEGACY-115`).
 *
 * 🔴 Маска существует с самого начала, но применялась только к телу запроса,
 * а `headers`, `query` и `params` уходили в событие как есть. В заголовках
 * лежат `Authorization` с рабочим JWT и `Cookie` с сессией, то есть в проекте
 * Sentry оседали действующие токены доступа тех, чей запрос упал с 5xx.
 *
 * ⚠️ Регистр не важен: Express отдаёт имена заголовков в нижнем регистре
 * (`authorization`, `cookie`), а тело запроса приходит в чужом регистре
 * (`Authorization`, `accessToken`), и оба случая закрывает флаг `i`.
 *
 * ⚠️ Совпадение частичное и это намеренно: `accessToken`, `refresh_token`,
 * `set-cookie` и `proxy-authorization` попадают под маску сами.
 */
const SENSITIVE_KEY_PATTERN = /password|token|authorization|secret|cookie/i;

/**
 * Global exception filter that reports 5xx errors to Sentry.
 * 4xx (400/401/403/404/429) are deliberately ignored to reduce noise.
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
              const safeUrl = this.redactUrl(req.originalUrl);
              scope.setTag('method', method);
              scope.setTag('route', routePath ?? path ?? 'unknown');
              scope.setTag('status_code', String(status));
              scope.setContext('request', {
                url: `${req.protocol}://${req.get('host')}${safeUrl}`,
                method,
                headers: this.redactKeys(req.headers),
                query: this.redactKeys(req.query),
                params: this.redactKeys(req.params),
                body: this.redactKeys(req.body),
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
              if (user?.id) {
                scope.setUser({ id: String(user.id), email: user.email });
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

  /**
   * Общий редактор ключей для всего, что кладётся в контекст события.
   *
   * ⚠️ Любое новое поле контекста обязано проходить через него — это записано
   * правилом в `LEGACY-115`, потому что заголовки миновали маску ровно так:
   * поле добавили рядом с уже замаскированным телом и сочли вопрос закрытым.
   *
   * ⚠️ Проход **поверхностный**: вложенное `{ user: { password } }` он не
   * чистит. Так было и в исходной маске тела; рекурсия — отдельная правка со
   * своей ценой (глубина, циклы, размер события), а не «заодно».
   */
  private redactKeys(value: unknown): unknown {
    if (!this.isPlainObject(value)) return value;
    const clone: Record<string, unknown> = { ...value };
    for (const key of Object.keys(clone)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        clone[key] = '[Filtered]';
      }
    }
    return clone;
  }

  /**
   * Адрес события без значений секретных параметров строки запроса (`LEGACY-189`).
   *
   * 🔴 Редактор ключей сюда неприменим по форме: он маскирует ключи объекта, а
   * `req.originalUrl` — текст. Без этого разбора значение, замаскированное в
   * `query`, тем же событием уезжало открытым в `url` и вторым разом в хлебной
   * крошке, то есть маска на `query` закрывала одно место из трёх.
   *
   * ⚠️ Разбором, а не регуляркой по строке: параметр может повторяться, быть
   * пустым и содержать процентное кодирование. Путь не трогаем — без него
   * событие бесполезно.
   */
  private redactUrl(rawUrl: string): string {
    const queryStart = rawUrl.indexOf('?');
    if (queryStart === -1) return rawUrl;

    const pathPart = rawUrl.slice(0, queryStart);
    const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
    for (const key of Array.from(new Set(params.keys()))) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        params.set(key, '[Filtered]');
      }
    }
    const query = params.toString();
    return query ? `${pathPart}?${query}` : pathPart;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getRoutePath(req: Request): string | undefined {
    // Express adds route.path to req; types do not expose it
    const maybeWithRoute = req as unknown as { route?: { path?: unknown } };
    const p = maybeWithRoute.route?.path;
    return typeof p === 'string' ? p : undefined;
  }

  private getUser(req: Request): { id?: string | number; email?: string } | undefined {
    const r = req as Request & { user?: { id?: string | number; email?: string } };
    return r.user;
  }
}
