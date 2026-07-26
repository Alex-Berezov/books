import { ConfigService } from '@nestjs/config';
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
});
