import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  HttpException,
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { MetricsService } from './metrics.service';
import type { Request, Response } from 'express';

/**
 * Express fills `req.route` once a handler has matched, and `req.baseUrl` holds
 * the mount prefix when the handler sits behind a router. Anything that did not
 * match a declared route has no template, and gets a single shared label rather
 * than its raw URL.
 */
function resolveRouteTemplate(req: Request | undefined): string {
  const layer = req as unknown as { route?: { path?: unknown } } | undefined;
  const matched: unknown = layer?.route?.path;
  if (typeof matched !== 'string' || matched.length === 0) return 'unmatched';
  const base = typeof req?.baseUrl === 'string' ? req.baseUrl : '';
  const template = `${base}${matched}`;
  return template.length > 0 ? template : 'unmatched';
}

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<Request>();
    const res = httpCtx.getResponse<Response>();

    const rawMethod: string = req?.method ?? 'GET';
    const method = rawMethod.toUpperCase();

    // The route *template* (`/api/:lang/book/:slug`), never the concrete path.
    //
    // Using `req.path` made every distinct URL its own label value, which is
    // two problems at once: the metrics endpoint then enumerates every address
    // that was ever visited, and an anonymous client walking made-up paths adds
    // an unbounded number of series to the prom-client registry — memory that
    // is never released.
    const route = resolveRouteTemplate(req);

    const stopTimer = this.metrics.startHttpTimer({ method, route });

    return next.handle().pipe(
      tap(() => {
        const status = res?.statusCode ?? 200;
        stopTimer({ status_code: status });
      }),
      catchError((err) => {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        stopTimer({ status_code: status });
        const normalized = err instanceof Error ? err : new Error('Unknown error');
        return throwError(() => normalized);
      }),
    );
  }
}
