import { Injectable } from '@nestjs/common';
import { Registry, collectDefaultMetrics, Histogram } from 'prom-client';

type HttpLabel = 'method' | 'route' | 'status_code';

@Injectable()
export class MetricsService {
  private readonly registry: Registry;
  private readonly httpHistogram: Histogram<HttpLabel>;

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
    return await this.registry.metrics();
  }

  // For tests/debugging
  async getMetricNames(): Promise<string[]> {
    const list = await this.registry.getMetricsAsJSON();
    return list.map((m) => m.name);
  }
}
