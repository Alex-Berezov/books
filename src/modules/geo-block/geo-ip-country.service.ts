import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type GeoRequestHeaders = Record<string, string | string[] | undefined>;

@Injectable()
export class GeoIpCountryService {
  constructor(private readonly config: ConfigService) {}

  resolveCountry(headers: GeoRequestHeaders, allowDebugHeader = false): string | null {
    const canUseGeoTestHeader =
      this.config.get<string>('NODE_ENV') === 'test' ||
      this.config.get<string>('ENABLE_GEO_TEST_HEADERS') === 'true' ||
      allowDebugHeader;

    if (canUseGeoTestHeader) {
      const testCountry = this.normalize(this.getHeader(headers, 'x-geo-country'));
      if (testCountry) return testCountry;
    }

    const cloudflareCountry = this.normalize(this.getHeader(headers, 'cf-ipcountry'));
    if (cloudflareCountry) return cloudflareCountry;

    const vercelCountry = this.normalize(this.getHeader(headers, 'x-vercel-ip-country'));
    if (vercelCountry) return vercelCountry;

    if (this.config.get<string>('ENABLE_X_COUNTRY_CODE_HEADER') === 'true') {
      return this.normalize(this.getHeader(headers, 'x-country-code'));
    }

    return null;
  }

  private getHeader(headers: GeoRequestHeaders, name: string): string | undefined {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private normalize(value: string | undefined): string | null {
    const countryCode = value?.trim().toUpperCase();
    if (!countryCode || countryCode === 'XX' || countryCode === 'UNKNOWN') return null;
    return /^[A-Z]{2}$/.test(countryCode) ? countryCode : null;
  }
}
