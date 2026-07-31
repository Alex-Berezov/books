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

  it('ignores invalid country codes', () => {
    const service = createService({ NODE_ENV: 'test' });

    expect(service.resolveCountry({ 'x-geo-country': 'invalid' })).toBeNull();
    expect(service.resolveCountry({ 'x-geo-country': 'XX' })).toBeNull();
  });

  it('uses CF-IPCountry when the debug header is unavailable', () => {
    const service = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'cf-ipcountry': 'de' })).toBe('DE');
  });

  it('returns null when no trusted country header is present', () => {
    const service = createService({ NODE_ENV: 'production' });

    expect(service.resolveCountry({ 'x-country-code': 'US' })).toBeNull();
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
