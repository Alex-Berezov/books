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
  // `resolveCountry`; a seventh name would slip past this list, so a real whitelist guard needs
  // the trusted names extracted into a constant first. That extraction was never done — it was
  // noted under LEGACY-208, which closed 12.09.2026 without it, so this list is the only thing
  // standing between a new platform header and a country the client picked.
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

  // The debug header is gated by NODE_ENV and by `allowDebugHeader`; production sets neither.
  it('ignores X-Geo-Country in production when the test headers are not enabled', () => {
    const { service } = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-geo-country': 'US' })).toBeNull();
  });

  // LEGACY-208, half closed 12.09.2026. This expectation was the opposite until that day: the key
  // switched the header on in any environment, and a deployment secret is not a place where "a
  // client may name its own country" should be decidable. The case is kept — inverted — precisely
  // because a green spec over an absent clause proves nothing: it turns red the moment the flag
  // is read again.
  it('ignores X-Geo-Country in production even when the retired flag is set', () => {
    const { service } = createService({ NODE_ENV: 'production', ENABLE_GEO_TEST_HEADERS: 'true' });

    expect(service.resolveCountry({ 'x-geo-country': 'us' })).toBeNull();
  });

  // The other half of the same switch, still live: `allowDebugHeader` is now the only way to name
  // a country outside tests, so it needs a positive case of its own. Without one the whole
  // `|| allowDebugHeader` can be deleted and every spec stays green — the two cases that pass
  // `true` below assert that the counters do NOT move, which an always-null lookup satisfies too.
  it('uses X-Geo-Country in production when the caller asks for a debug lookup', () => {
    const { service } = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-geo-country': 'gb' }, true)).toBe('GB');
  });

  // The second retired key, pinned in both positions for the same reason as the first: a green
  // spec over an absent clause proves nothing, so the case that used to demand `'US'` with the
  // flag on now demands `null` either way. Restoring the branch turns the `on` half red — the
  // `off` half stays green by design, since with the key unset the branch would not fire even if
  // it were back; it is here to pin both sides of a switch that no longer exists.
  it('ignores X-Country-Code with and without the retired flag', () => {
    const { service: off } = createService({ NODE_ENV: 'production' });
    const { service: on } = createService({
      NODE_ENV: 'production',
      ENABLE_X_COUNTRY_CODE_HEADER: 'true',
    });

    expect(off.resolveCountry({ 'x-country-code': 'us' })).toBeNull();
    expect(on.resolveCountry({ 'x-country-code': 'us' })).toBeNull();
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
    // Three points around the threshold, the middle one exactly on it. The alert rule carries the
    // same 0.05 and the two are required to agree, so the comparison itself has to be pinned: with
    // only 4 % and 6 % measured, `>` could become `>=` (or the constant could be multiplied at the
    // point of use) and every case here would stay green while the admin endpoint said DEGRADED
    // and the rule stayed silent.
    it.each([
      [96, 4, 0.04, GeoCountrySourceStatus.HEALTHY],
      [95, 5, 0.05, GeoCountrySourceStatus.HEALTHY],
      [94, 6, 0.06, GeoCountrySourceStatus.DEGRADED],
    ])(
      'with %i resolved and %i countryless requests the ratio is %f and the status is %s',
      (resolved, unknown, ratio, status) => {
        const { service } = createService({ NODE_ENV: 'production' });

        for (let index = 0; index < resolved; index += 1) {
          service.resolveCountry({ 'cf-ipcountry': 'de' });
        }
        for (let index = 0; index < unknown; index += 1) service.resolveCountry({});

        expect(service.getSourceHealth().unknownRatio).toBeCloseTo(ratio, 5);
        expect(service.getSourceHealth().status).toBe(status);
      },
    );

    // The lower bound of UNAVAILABLE: MIN_SAMPLES_FOR_OUTAGE keeps a quiet night from reading as
    // an outage, and the alert rule carries the same floor as a sample-count threshold. Asserting
    // the exact status, not merely "not UNAVAILABLE" — an early return of HEALTHY below the floor
    // would satisfy a negative assertion while hiding an outage on low traffic from the admin too.
    it('calls 19 countryless requests degraded, not an outage', () => {
      const { service } = createService({ NODE_ENV: 'production' });

      for (let index = 0; index < 19; index += 1) service.resolveCountry({});

      expect(service.getSourceHealth().status).toBe(GeoCountrySourceStatus.DEGRADED);
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

    // LEGACY-208 left two resolving headers where there were three, so the second series here is
    // `x-geo-country` under NODE_ENV === 'test' rather than the retired `x-country-code`. The
    // point of the case is unchanged: two headers, two series, not one sum.
    it('separates the headers instead of summing them into one series', async () => {
      const { service, metrics } = createService({ NODE_ENV: 'test' });

      service.resolveCountry({ 'cf-ipcountry': 'de' });
      service.resolveCountry({ 'cf-ipcountry': 'fr' });
      service.resolveCountry({ 'x-geo-country': 'us' });

      expect(
        await metrics.getCounterValue('geo_country_resolved_total', { header: 'cf-ipcountry' }),
      ).toBe(2);
      expect(
        await metrics.getCounterValue('geo_country_resolved_total', { header: 'x-geo-country' }),
      ).toBe(1);
    });

    // The second and last resolving call site — there were three until LEGACY-208 removed the
    // `x-country-code` branch. Named separately because a typo in the header string passed to
    // `record` would produce a series under a name no dashboard queries, and every other spec in
    // this file would stay green.
    it('labels the staging debug header with its own name', async () => {
      const { service, metrics } = createService({ NODE_ENV: 'test' });

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
