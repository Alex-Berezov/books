import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('collects default metrics and exposes histogram', async () => {
    const svc = new MetricsService();
    const names = await svc.getMetricNames();
    expect(names).toContain('process_cpu_user_seconds_total');
    expect(names).toContain('http_request_duration_seconds');
  });

  it('measures http request duration with labels', async () => {
    const svc = new MetricsService();
    const stop = svc.startHttpTimer({ method: 'GET', route: '/health' });
    // simulate work
    await new Promise((r) => setTimeout(r, 10));
    stop({ status_code: 200 });

    const text = await svc.getMetrics();
    expect(text).toContain('http_request_duration_seconds_count');
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/health"');
  });
});
