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

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<Request>();
    const res = httpCtx.getResponse<Response>();

    const rawMethod: string = req?.method ?? 'GET';
    const method = rawMethod.toUpperCase();
    const route = req?.path || req?.originalUrl || 'unknown';

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
