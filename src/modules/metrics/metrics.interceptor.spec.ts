import { of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import type { ExecutionContext, CallHandler } from '@nestjs/common';

function createCtx(
  req: { path?: string; method?: string; route?: { path?: string }; baseUrl?: string },
  statusCode = 200,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', ...req }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

async function record(ctx: ExecutionContext, next: CallHandler): Promise<string> {
  const metrics = new MetricsService();
  const interceptor = new MetricsInterceptor(metrics);
  await interceptor
    .intercept(ctx, next)
    .toPromise()
    .catch(() => undefined);
  return metrics.getMetrics();
}

const ok: CallHandler = { handle: () => of({ ok: true }) } as CallHandler;

describe('MetricsInterceptor', () => {
  it('records success responses', async () => {
    const text = await record(createCtx({ path: '/ok', route: { path: '/ok' } }), ok);
    expect(text).toContain('http_request_duration_seconds_count');
    expect(text).toContain('route="/ok"');
    expect(text).toContain('method="GET"');
  });

  it('records error responses', async () => {
    const next: CallHandler = {
      handle: () => throwError(() => Object.assign(new Error('boom'), { status: 503 })),
    } as CallHandler;
    const text = await record(
      createCtx({ path: '/fail', method: 'POST', route: { path: '/fail' } }, 500),
      next,
    );
    expect(text).toContain('route="/fail"');
    expect(text).toContain('method="POST"');
  });

  // CR auth-social, mandatory item 3. The label used to be `req.path`, so every
  // distinct URL became its own series: the metrics output enumerated every
  // address ever visited, and an anonymous caller walking made-up paths grew the
  // registry without bound.
  it('labels the route with its template, not the concrete path', async () => {
    const text = await record(
      createCtx({
        path: '/api/en/book/the-picture-of-dorian-gray',
        route: { path: '/api/:lang/book/:slug' },
      }),
      ok,
    );

    expect(text).toContain('route="/api/:lang/book/:slug"');
    expect(text).not.toContain('the-picture-of-dorian-gray');
  });

  it('prefixes the mount path when the handler sits behind a router', async () => {
    const text = await record(
      createCtx({ path: '/api/tags/x', baseUrl: '/api', route: { path: '/tags/:slug' } }),
      ok,
    );

    expect(text).toContain('route="/api/tags/:slug"');
  });

  it('collapses anything without a matched route into a single label', async () => {
    const text = await record(createCtx({ path: '/api/made/up/path/42' }), ok);

    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('/api/made/up/path/42');
  });

  it('does not create a new series per made-up path', async () => {
    const metrics = new MetricsService();
    const interceptor = new MetricsInterceptor(metrics);
    for (const suffix of ['a', 'b', 'c', 'd']) {
      await interceptor.intercept(createCtx({ path: `/api/junk/${suffix}` }), ok).toPromise();
    }

    const text = await metrics.getMetrics();
    const countLines = text
      .split('\n')
      .filter((line) => line.startsWith('http_request_duration_seconds_count'));
    expect(countLines).toHaveLength(1);
    expect(countLines[0]).toContain('route="unmatched"');
  });
});
