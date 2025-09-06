import { of, throwError } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

function createCtx(path = '/test', method = 'GET', statusCode = 200): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path, method }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

describe('MetricsInterceptor', () => {
  it('records success responses', async () => {
    const metrics = new MetricsService();
    const interceptor = new MetricsInterceptor(metrics);
    const ctx = createCtx('/ok', 'GET', 200);
    const next: CallHandler = { handle: () => of({ ok: true }) } as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();
    const text = await metrics.getMetrics();
    expect(text).toContain('http_request_duration_seconds_count');
    expect(text).toContain('route="/ok"');
    expect(text).toContain('method="GET"');
  });

  it('records error responses', async () => {
    const metrics = new MetricsService();
    const interceptor = new MetricsInterceptor(metrics);
    const ctx = createCtx('/fail', 'POST', 500);
    const next: CallHandler = {
      handle: () => throwError(() => Object.assign(new Error('boom'), { status: 503 })),
    } as CallHandler;

    await interceptor
      .intercept(ctx, next)
      .toPromise()
      .catch(() => undefined);

    const text = await metrics.getMetrics();
    expect(text).toContain('route="/fail"');
    expect(text).toContain('method="POST"');
  });
});
