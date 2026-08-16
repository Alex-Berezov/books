import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * The prom-client registry and nothing else — the module a domain module imports when it needs
 * to record a metric.
 *
 * LEGACY-206: importing the full `MetricsModule` for this drags in `MetricsController` and
 * `MetricsAccessGuard`, and the guard needs `ModeratorRolesService` from an unrelated branch of
 * the graph; `GeoBlockModule` failed to compile on it. Without controllers or guards this module
 * adds nothing to the importer's graph.
 *
 * One registry per application: `/api/metrics` and the domain counters must write to the same
 * one, or Prometheus scrapes half of them. `geo-metrics-wiring.spec.ts` pins that.
 */
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsRegistryModule {}
