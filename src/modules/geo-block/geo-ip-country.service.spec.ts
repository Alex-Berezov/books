import { ConfigService } from '@nestjs/config';
import { GeoCountrySourceStatus } from './dto/geo-block.dto';
import { GeoIpCountryService } from './geo-ip-country.service';

const createService = (values: Record<string, string | undefined>): GeoIpCountryService => {
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new GeoIpCountryService(config);
};

describe('GeoIpCountryService', () => {
  it('uses X-Geo-Country in test environment', () => {
    const service = createService({ NODE_ENV: 'test' });

    expect(service.resolveCountry({ 'x-geo-country': 'gb' })).toBe('GB');
  });

  // `XX` is what Cloudflare sends when it could not place the address and `T1` is what it sends
  // for Tor; both must stay unknown. The whole `allow` decision of LEGACY-171 rests on this — they
  // are the live population of countryless traffic, and a rule is never written against them.
  it('ignores invalid country codes', () => {
    const service = createService({ NODE_ENV: 'test' });

    expect(service.resolveCountry({ 'x-geo-country': 'invalid' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'XX' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'T1' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'UNKNOWN' })).toBeNull();
  });

  it('uses CF-IPCountry when the debug header is unavailable', () => {
    const service = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'cf-ipcountry': 'de' })).toBe('DE');
  });

  // LEGACY-172: the country may only come from a header the edge overwrites for every request.
  // `x-vercel-ip-country` was accepted unconditionally although no Vercel edge ever sets or strips
  // it, so any client could name its own country whenever `cf-ipcountry` was absent. One call per
  // header, so that a failure names the header that started answering again.
  it('returns null when no trusted country header is present', () => {
    const service = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-country-code': 'US' })).toBeNull();
    expect(service.resolveCountry({ 'x-vercel-ip-country': 'US' })).toBeNull();
  });

  // The platform headers a request can plausibly arrive with, none of which any proxy in front of
  // this origin overwrites. Named one by one because the trusted set lives inline in
  // `resolveCountry`; a seventh name would slip past this list, so a real whitelist guard needs the
  // trusted names extracted into a constant first (LEGACY-208).
  it('takes the country from no header other than the trusted ones', () => {
    const service = createService({ NODE_ENV: 'production' });

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
    const service = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-geo-country': 'US' })).toBeNull();
  });

  // The other half of the same switch: outside tests the header works only while the flag is on,
  // which is how a controlled staging debug is meant to happen. Without this the whole clause
  // could be deleted and every spec would stay green.
  it('uses X-Geo-Country outside tests only when the flag enables it', () => {
    const service = createService({ NODE_ENV: 'production', ENABLE_GEO_TEST_HEADERS: 'true' });

    expect(service.resolveCountry({ 'x-geo-country': 'us' })).toBe('US');
  });

  // The other flag, pinned the same way in both positions. This half is a snapshot, not an intent:
  // nothing in this deployment overwrites `x-country-code`, so turning the flag on lets the client
  // pick its own market (LEGACY-208). When that branch goes, this expectation becomes `null`.
  it('uses X-Country-Code only while its own flag is on', () => {
    const off = createService({ NODE_ENV: 'production' });
    const on = createService({ NODE_ENV: 'production', ENABLE_X_COUNTRY_CODE_HEADER: 'true' });

    expect(off.resolveCountry({ 'x-country-code': 'us' })).toBeNull();
    expect(on.resolveCountry({ 'x-country-code': 'us' })).toBe('US');
  });

  describe('country source health (WP-1.2а)', () => {
    it('reports NO_DATA before any request was resolved', () => {
      const health = createService({ NODE_ENV: 'production' }).getSourceHealth();

      expect(health.status).toBe(GeoCountrySourceStatus.NO_DATA);
      expect(health.totalCount).toBe(0);
      expect(health.unknownRatio).toBe(0);
    });

    it('counts resolved requests and names the header that supplied the country', () => {
      const service = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ 'cf-ipcountry': 'de' });

      const health = service.getSourceHealth();
      expect(health.status).toBe(GeoCountrySourceStatus.HEALTHY);
      expect(health.resolvedCount).toBe(1);
      expect(health.unknownCount).toBe(0);
      expect(health.lastResolvedHeader).toBe('cf-ipcountry');
      expect(health.lastResolvedAt).not.toBeNull();
    });

    it('reports UNAVAILABLE once enough requests arrived without any country at all', () => {
      const service = createService({ NODE_ENV: 'production' });

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
      const service = createService({ NODE_ENV: 'production' });

      for (let index = 0; index < 6; index += 1) service.resolveCountry({ 'cf-ipcountry': 'de' });
      for (let index = 0; index < 4; index += 1) service.resolveCountry({});

      expect(service.getSourceHealth().status).toBe(GeoCountrySourceStatus.DEGRADED);
    });

    it('does not count admin debug lookups as production traffic', () => {
      const service = createService({ NODE_ENV: 'production' });

      service.resolveCountry({ 'x-geo-country': 'GB' }, true);

      expect(service.getSourceHealth().totalCount).toBe(0);
    });
  });
});
