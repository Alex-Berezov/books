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

  describe('geo country counters (LEGACY-206)', () => {
    it('registers both counters in the exposed registry', async () => {
      const names = await new MetricsService().getMetricNames();

      expect(names).toContain('geo_country_resolved_total');
      expect(names).toContain('geo_country_unknown_total');
    });

    it('keeps one series per header', async () => {
      const svc = new MetricsService();

      svc.recordGeoCountryResolved('cf-ipcountry');
      svc.recordGeoCountryResolved('cf-ipcountry');
      svc.recordGeoCountryResolved('x-country-code');
      svc.recordGeoCountryUnknown();

      expect(
        await svc.getCounterValue('geo_country_resolved_total', { header: 'cf-ipcountry' }),
      ).toBe(2);
      expect(
        await svc.getCounterValue('geo_country_resolved_total', { header: 'x-country-code' }),
      ).toBe(1);
      expect(await svc.getCounterValue('geo_country_unknown_total')).toBe(1);
    });
  });

  describe('getCounterValue', () => {
    it('returns null for a metric that is not registered at all', async () => {
      expect(await new MetricsService().getCounterValue('no_such_metric_total')).toBeNull();
    });

    it('returns null for a label set that has no series yet', async () => {
      const svc = new MetricsService();

      svc.recordGeoCountryResolved('cf-ipcountry');

      expect(
        await svc.getCounterValue('geo_country_resolved_total', { header: 'x-geo-country' }),
      ).toBeNull();
    });

    // Exact match, not subset: asking without labels must not silently answer with the first
    // labelled series, which would read like a total and be wrong by however many series exist.
    it('does not answer a label-less question with a labelled series', async () => {
      const svc = new MetricsService();

      svc.recordGeoCountryResolved('cf-ipcountry');
      svc.recordGeoCountryResolved('x-country-code');

      expect(await svc.getCounterValue('geo_country_resolved_total')).toBeNull();
    });

    it('reports zero for an unlabelled counter that was never incremented', async () => {
      expect(await new MetricsService().getCounterValue('geo_country_unknown_total')).toBe(0);
    });
  });
});
