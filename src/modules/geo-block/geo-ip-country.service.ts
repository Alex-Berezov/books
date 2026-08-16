import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { GeoCountrySourceHealthDto, GeoCountrySourceStatus } from './dto/geo-block.dto';

export type GeoRequestHeaders = Record<string, string | string[] | undefined>;

/** Below this many observations an all-unknown streak is not yet evidence of an outage. */
const MIN_SAMPLES_FOR_OUTAGE = 20;
/** Above this share of countryless requests the source is no longer trustworthy. */
const DEGRADED_UNKNOWN_RATIO = 0.05;

@Injectable()
export class GeoIpCountryService {
  private resolvedCount = 0;
  private unknownCount = 0;
  private lastResolvedHeader: string | null = null;
  private lastResolvedAt: Date | null = null;
  private lastUnknownAt: Date | null = null;
  private readonly windowStartedAt = new Date();

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * LEGACY-172. `cf-ipcountry` is trusted for one reason only: firewalld lets Cloudflare ranges
   * reach the origin and nothing else (LEGACY-077), so Cloudflare overwrites the header on every
   * request that gets here. Drop those rules or add a second entry point and this method starts
   * believing whatever the client typed, silently — a header is just a string to types and tests.
   * Never add a header no proxy in front of the origin overwrites.
   */
  resolveCountry(headers: GeoRequestHeaders, allowDebugHeader = false): string | null {
    const canUseGeoTestHeader =
      this.config.get<string>('NODE_ENV') === 'test' ||
      this.config.get<string>('ENABLE_GEO_TEST_HEADERS') === 'true' ||
      allowDebugHeader;

    if (canUseGeoTestHeader) {
      const testCountry = this.normalize(this.getHeader(headers, 'x-geo-country'));
      if (testCountry) return this.record('x-geo-country', testCountry, allowDebugHeader);
    }

    const cloudflareCountry = this.normalize(this.getHeader(headers, 'cf-ipcountry'));
    if (cloudflareCountry) return this.record('cf-ipcountry', cloudflareCountry, allowDebugHeader);

    if (this.config.get<string>('ENABLE_X_COUNTRY_CODE_HEADER') === 'true') {
      const fallbackCountry = this.normalize(this.getHeader(headers, 'x-country-code'));
      if (fallbackCountry) return this.record('x-country-code', fallbackCountry, allowDebugHeader);
    }

    return this.record(null, null, allowDebugHeader);
  }

  /**
   * WP-1.2а. Phase 12 rests on a header added by an upstream proxy, so the application cannot
   * tell "this visitor has no country" from "the country source was switched off". Counting both
   * outcomes turns the second case into something an editor can see instead of a silent no-op.
   */
  getSourceHealth(): GeoCountrySourceHealthDto {
    const totalCount = this.resolvedCount + this.unknownCount;
    const unknownRatio = totalCount === 0 ? 0 : this.unknownCount / totalCount;

    return {
      status: this.resolveStatus(totalCount, unknownRatio),
      resolvedCount: this.resolvedCount,
      unknownCount: this.unknownCount,
      totalCount,
      unknownRatio,
      lastResolvedHeader: this.lastResolvedHeader,
      lastResolvedAt: this.lastResolvedAt ? this.lastResolvedAt.toISOString() : null,
      lastUnknownAt: this.lastUnknownAt ? this.lastUnknownAt.toISOString() : null,
      windowStartedAt: this.windowStartedAt.toISOString(),
    };
  }

  private resolveStatus(totalCount: number, unknownRatio: number): GeoCountrySourceStatus {
    if (totalCount === 0) return GeoCountrySourceStatus.NO_DATA;
    if (this.resolvedCount === 0 && totalCount >= MIN_SAMPLES_FOR_OUTAGE) {
      return GeoCountrySourceStatus.UNAVAILABLE;
    }
    if (unknownRatio > DEGRADED_UNKNOWN_RATIO) return GeoCountrySourceStatus.DEGRADED;
    return GeoCountrySourceStatus.HEALTHY;
  }

  /**
   * Admin lookups pass their own header and would distort the picture of production traffic,
   * so they are observed but not counted.
   *
   * LEGACY-206. The same two outcomes also go out as prom-client counters, and for the same
   * reason the debug branch is excluded from both: an alert built on admin traffic would read
   * differently from what the admin endpoint shows. Both branches must increment — with only one
   * of them wired the ratio in the alert rule is silently wrong instead of missing.
   */
  private record(
    header: string | null,
    countryCode: string | null,
    isDebugLookup: boolean,
  ): string | null {
    if (isDebugLookup) return countryCode;

    // A country always arrives together with the header that carried it: the three resolving
    // call sites pass both, the fourth passes neither. The `header &&` half of the condition
    // states that invariant instead of papering over it with a `'unknown'` label value that
    // no traffic can ever produce — a series like that only misleads whoever queries it.
    if (countryCode && header) {
      this.resolvedCount += 1;
      this.lastResolvedHeader = header;
      this.lastResolvedAt = new Date();
      this.metrics.recordGeoCountryResolved(header);
    } else {
      this.unknownCount += 1;
      this.lastUnknownAt = new Date();
      this.metrics.recordGeoCountryUnknown();
    }
    return countryCode;
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
