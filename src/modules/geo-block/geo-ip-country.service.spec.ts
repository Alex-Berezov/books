import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { GeoCountrySourceStatus } from './dto/geo-block.dto';
import { GeoIpCountryService } from './geo-ip-country.service';

/**
 * LEGACY-206: a real `MetricsService`, not a `jest.fn()` mock. A mock would only confirm the
 * call happened; the question is whether the value in the prom-client registry grew — that
 * registry is what Prometheus scrapes and what the country-source alert rules read.
 */
const createService = (
  values: Record<string, string | undefined>,
): { service: GeoIpCountryService; metrics: MetricsService } => {
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const metrics = new MetricsService();
  return { service: new GeoIpCountryService(config, metrics), metrics };
};

describe('GeoIpCountryService', () => {
  it('uses X-Geo-Country in test environment', () => {
    const { service } = createService({ NODE_ENV: 'test' });

    expect(service.resolveCountry({ 'x-geo-country': 'gb' })).toBe('GB');
  });

  // `XX` is what Cloudflare sends when it could not place the address and `T1` is what it sends
  // for Tor; both must stay unknown. The whole `allow` decision of LEGACY-171 rests on this — they
  // are the live population of countryless traffic, and a rule is never written against them.
  it('ignores invalid country codes', () => {
    const { service } = createService({ NODE_ENV: 'test' });

    expect(service.resolveCountry({ 'x-geo-country': 'invalid' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'XX' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'T1' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'UNKNOWN' })).toBeNull();
  });

  it('uses CF-IPCountry when the debug header is unavailable', () => {
    const { service } = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'cf-ipcountry': 'de' })).toBe('DE');
  });

  // LEGACY-172: the country may only come from a header the edge overwrites for every request.
  // `x-vercel-ip-country` was accepted unconditionally although no Vercel edge ever sets or strips
  // it, so any client could name its own country whenever `cf-ipcountry` was absent. One call per
  // header, so that a failure names the header that started answering again.
  it('returns null when no trusted country header is present', () => {
    const { service } = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-country-code': 'US' })).toBeNull();
    expect(service.resolveCountry({ 'x-vercel-ip-country': 'US' })).toBeNull();
  });

  // The platform headers a request can plausibly arrive with, none of which any proxy in front of
  // this origin overwrites. Named one by one because the trusted set lives inline in
  // `resolveCountry`; a seventh name would slip past this list, so a real whitelist guard needs the
  // trusted names extracted into a constant first (LEGACY-208).
  it('takes the country from no header other than the trusted ones', () => {
    const { service } = createService({ NODE_ENV: 'production' });

    expect(
      service.resolveCountry({
        'x-vercel-ip-country': 'US',
        'x-appengine-country': 'US',
        'fastly-client-country': 'US',
        'true-client-ip': '1.2.3.4',
        'x-forwarded-for': '1.2.3.4',
        'x-country-code': 'US',
      }),
    ).toBeNull();
  });

  // The debug header is gated by NODE_ENV/ENABLE_GEO_TEST_HEADERS; production sets neither.
  it('ignores X-Geo-Country in production when the test headers are not enabled', () => {
    const { service } = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-geo-country': 'US' })).toBeNull();
  });

  // The other half of the same switch: outside tests the header works only while the flag is on,
  // which is how a controlled staging debug is meant to happen. Without this the whole clause
  // could be deleted and every spec would stay green.
  it('uses X-Geo-Country outside tests only when the flag enables it', () => {
    const { service } = createService({ NODE_ENV: 'production', ENABLE_GEO_TEST_HEADERS: 'true' });

    expect(service.resolveCountry({ 'x-geo-country': 'us' })).toBe('US');
  });

  // The other flag, pinned the same way in both positions. This half is a snapshot, not an intent:
  // nothing in this deployment overwrites `x-country-code`, so turning the flag on lets the client
  // pick its own market (LEGACY-208). When that branch goes, this expectation becomes `null`.
  it('uses X-Country-Code only while its own flag is on', () => {
    const { service: off } = createService({ NODE_ENV: 'production' });
    const { service: on } = createService({
      NODE_ENV: 'production',
      ENABLE_X_COUNTRY_CODE_HEADER: 'true',
    });

    expect(off.resolveCountry({ 'x-country-code': 'us' })).toBeNull();
    expect(on.resolveCountry({ 'x-country-code': 'us' })).toBe('US');
  });

  describe('country source health (WP-1.2а)', () => {
    it('reports NO_DATA before any request was resolved', () => {
      const health = createService({ NODE_ENV: 'production' }).service.getSourceHealth();

      expect(health.status).toBe(GeoCountrySourceStatus.NO_DATA);
      expect(health.totalCount).toBe(0);
      expect(health.unknownRatio).toBe(0);
    });

    it('counts resolved requests and names the header that supplied the country', () => {
      const { service } = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ 'cf-ipcountry': 'de' });

      const health = service.getSourceHealth();
      expect(health.status).toBe(GeoCountrySourceStatus.HEALTHY);
      expect(health.resolvedCount).toBe(1);
      expect(health.unknownCount).toBe(0);
      expect(health.lastResolvedHeader).toBe('cf-ipcountry');
      expect(health.lastResolvedAt).not.toBeNull();
    });

    it('reports UNAVAILABLE once enough requests arrived without any country at all', () => {
      const { service } = createService({ NODE_ENV: 'production' });

      for (let index = 0; index < 20; index += 1) {
        service.resolveCountry({ host: 'api.bibliaris.com' });
      }

      const health = service.getSourceHealth();
      expect(health.status).toBe(GeoCountrySourceStatus.UNAVAILABLE);
      expect(health.unknownCount).toBe(20);
      expect(health.unknownRatio).toBe(1);
      expect(health.lastUnknownAt).not.toBeNull();
    });

    it('reports DEGRADED when a noticeable share of requests has no country', () => {
      const { service } = createService({ NODE_ENV: 'production' });

      for (let index = 0; index < 6; index += 1) service.resolveCountry({ 'cf-ipcountry': 'de' });
      for (let index = 0; index < 4; index += 1) service.resolveCountry({});

      expect(service.getSourceHealth().status).toBe(GeoCountrySourceStatus.DEGRADED);
    });

    // The boundary, not a share far past it. The alert rule carries the same 0.05 and the two are
    // required to agree (`geo-metrics-wiring.spec.ts` compares the numbers); without a test at the
    // edge, `DEGRADED_UNKNOWN_RATIO` could be multiplied in place and every other case here would
    // stay green while the admin endpoint said HEALTHY and the channel got a warning.
    it('switches to DEGRADED exactly at the ratio the alert rule uses', () => {
      const healthy = createService({ NODE_ENV: 'production' }).service;
      for (let index = 0; index < 96; index += 1) healthy.resolveCountry({ 'cf-ipcountry': 'de' });
      for (let index = 0; index < 4; index += 1) healthy.resolveCountry({});

      // 4 % — at the threshold, not above it.
      expect(healthy.getSourceHealth().unknownRatio).toBeCloseTo(0.04, 5);
      expect(healthy.getSourceHealth().status).toBe(GeoCountrySourceStatus.HEALTHY);

      const degraded = createService({ NODE_ENV: 'production' }).service;
      for (let index = 0; index < 94; index += 1) degraded.resolveCountry({ 'cf-ipcountry': 'de' });
      for (let index = 0; index < 6; index += 1) degraded.resolveCountry({});

      expect(degraded.getSourceHealth().unknownRatio).toBeCloseTo(0.06, 5);
      expect(degraded.getSourceHealth().status).toBe(GeoCountrySourceStatus.DEGRADED);
    });

    // The lower bound of UNAVAILABLE: MIN_SAMPLES_FOR_OUTAGE keeps a quiet night from reading as
    // an outage, and the alert rule carries the same floor as a sample-count threshold.
    it('does not call it an outage below the minimum sample count', () => {
      const { service } = createService({ NODE_ENV: 'production' });

      for (let index = 0; index < 19; index += 1) service.resolveCountry({});

      expect(service.getSourceHealth().status).not.toBe(GeoCountrySourceStatus.UNAVAILABLE);
    });

    it('does not count admin debug lookups as production traffic', () => {
      const { service } = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ 'x-geo-country': 'GB' }, true);

      expect(service.getSourceHealth().totalCount).toBe(0);
    });
  });

  /**
   * LEGACY-206. The in-memory counters are visible only through the admin endpoint; the
   * country-source alert rules read these series from the prom-client registry. The series
   * value is asserted, not the call: an increment that landed in another registry, or under
   * another metric name, does not exist as far as Prometheus is concerned.
   */
  describe('prom-client counters (LEGACY-206)', () => {
    it('counts a resolved country under the header that supplied it', async () => {
      const { service, metrics } = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ 'cf-ipcountry': 'de' });

      expect(
        await metrics.getCounterValue('geo_country_resolved_total', { header: 'cf-ipcountry' }),
      ).toBe(1);
      expect(await metrics.getCounterValue('geo_country_unknown_total')).toBe(0);
    });

    // The other branch of `record`. Both must increment: the rule computes a ratio, so a single
    // missing increment does not silence it — it makes it lie, numerator against a stale denominator.
    it('counts a request that arrived without any country', async () => {
      const { service, metrics } = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ host: 'api.bibliaris.com' });

      expect(await metrics.getCounterValue('geo_country_unknown_total')).toBe(1);
      expect(await metrics.getCounterValue('geo_country_resolved_total')).toBeNull();
    });

    it('separates the headers instead of summing them into one series', async () => {
      const { service, metrics } = createService({
        NODE_ENV: 'production',
        ENABLE_X_COUNTRY_CODE_HEADER: 'true',
      });

      service.resolveCountry({ 'cf-ipcountry': 'de' });
      service.resolveCountry({ 'cf-ipcountry': 'fr' });
      service.resolveCountry({ 'x-country-code': 'us' });

      expect(
        await metrics.getCounterValue('geo_country_resolved_total', { header: 'cf-ipcountry' }),
      ).toBe(2);
      expect(
        await metrics.getCounterValue('geo_country_resolved_total', { header: 'x-country-code' }),
      ).toBe(1);
    });

    // The third resolving call site. Named separately because a typo in the header string passed
    // to `record` would produce a series under a name no dashboard queries, and every other spec
    // in this file would stay green.
    it('labels the staging debug header with its own name', async () => {
      const { service, metrics } = createService({
        NODE_ENV: 'production',
        ENABLE_GEO_TEST_HEADERS: 'true',
      });

      service.resolveCountry({ 'x-geo-country': 'gb' });

      expect(
        await metrics.getCounterValue('geo_country_resolved_total', { header: 'x-geo-country' }),
      ).toBe(1);
    });

    // The `isDebugLookup` branch is excluded from the metrics for the same reason it is excluded
    // from the in-memory counters: admin lookups distort the picture of production traffic, and an
    // alert fed by them would read differently from what the admin endpoint shows.
    it('leaves admin debug lookups out of the counters as well', async () => {
      const { service, metrics } = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ 'x-geo-country': 'GB' }, true);
      service.resolveCountry({}, true);

      expect(await metrics.getCounterValue('geo_country_resolved_total')).toBeNull();
      expect(await metrics.getCounterValue('geo_country_unknown_total')).toBe(0);
    });
  });
});
