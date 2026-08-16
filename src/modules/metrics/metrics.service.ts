import { Injectable } from '@nestjs/common';
import { Registry, collectDefaultMetrics, Histogram, Counter } from 'prom-client';

type HttpLabel = 'method' | 'route' | 'status_code';
type GeoCountryLabel = 'header';

@Injectable()
export class MetricsService {
  private readonly registry: Registry;
  private readonly httpHistogram: Histogram<HttpLabel>;
  private readonly geoCountryResolved: Counter<GeoCountryLabel>;
  private readonly geoCountryUnknown: Counter<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    const labelNames = ['method', 'route', 'status_code'] as const;
    this.httpHistogram = new Histogram<HttpLabel>({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds labelled with method, route and status_code',
      labelNames,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // LEGACY-206. The geo contour rests entirely on a header set by an upstream proxy, and its
    // loss signalled nothing: the counters lived in `GeoIpCountryService` memory, visible only
    // through an admin endpoint nobody opens.
    //
    // `Counter`, not a `Gauge` holding a ready-made ratio: the in-memory counters never reset,
    // so their ratio drifts into an average over the whole process lifetime and a fresh outage
    // dissolves in it; with several replicas each keeps its own tally. The window belongs in the
    // alert rule (`rate(...[5m])`), not in the application.
    this.geoCountryResolved = new Counter<GeoCountryLabel>({
      name: 'geo_country_resolved_total',
      help: 'Requests whose country was resolved, labelled with the header that provided it',
      labelNames: ['header'] as const,
      registers: [this.registry],
    });
    this.geoCountryUnknown = new Counter({
      name: 'geo_country_unknown_total',
      help: 'Requests whose country could not be resolved from any trusted header',
      registers: [this.registry],
    });
  }

  recordGeoCountryResolved(header: string): void {
    this.geoCountryResolved.inc({ header });
  }

  recordGeoCountryUnknown(): void {
    this.geoCountryUnknown.inc();
  }

  startHttpTimer(
    labels: Partial<Record<HttpLabel, string | number>> = {},
  ): (labels?: Partial<Record<HttpLabel, string | number>>) => number {
    return this.httpHistogram.startTimer(labels);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  // For tests/debugging
  async getMetricNames(): Promise<string[]> {
    const list = await this.registry.getMetricsAsJSON();
    return list.map((m) => m.name);
  }

  /**
   * Value of one series, or `null` when the registry holds no sample with those labels.
   *
   * For tests: names alone are not enough, because "the metric is registered" stays green with
   * the increment missing. Deliberately not a thin wrapper over `registry.getMetricsAsJSON()` —
   * a method differing from it by one letter is the kind of pair that gets called by mistake
   * without the compiler noticing. An unlabelled counter reports `0` from the start; a labelled
   * one has no series at all until its first `inc`, and that difference is `0` versus `null`.
   */
  async getCounterValue(name: string, labels: Record<string, string> = {}): Promise<number | null> {
    const list = (await this.registry.getMetricsAsJSON()) as {
      name: string;
      values?: { value: number; labels?: Record<string, string | number> }[];
    }[];

    const samples = list.find((metric) => metric.name === name)?.values ?? [];

    // Exact label-set match, not a subset. Subset matching makes `getCounterValue(name)` with no
    // labels return the first series of a labelled metric — the value of whichever label was
    // incremented first, reading like a total. Requiring equality means "no labels" asks for the
    // unlabelled series and gets `null` when the metric only has labelled ones.
    const sample = samples.find((item) => {
      const actual = item.labels ?? {};
      const keys = Object.keys(actual);
      return (
        keys.length === Object.keys(labels).length &&
        keys.every((key) => actual[key] === labels[key])
      );
    });

    return sample ? sample.value : null;
  }
}
