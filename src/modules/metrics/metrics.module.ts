import { Module } from '@nestjs/common';
import { MetricsInterceptor } from './metrics.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './metrics.controller';
import { MetricsAccessGuard } from './metrics-access.guard';
import { MetricsRegistryModule } from './metrics-registry.module';

/**
 * The HTTP surface of metrics: the `/api/metrics` endpoint, its access guard and the interceptor
 * that times every request. Imported once, by `AppModule`.
 *
 * 🔴 A domain module that only needs to increment a counter must import `MetricsRegistryModule`,
 * not this one. This module drags in `MetricsAccessGuard`, which depends on `ModeratorRolesService`
 * from an unrelated branch of the graph — `GeoBlockModule` failed to compile on exactly that
 * (LEGACY-206). The registry itself lives in `MetricsRegistryModule` and is re-exported here, so
 * both paths share one `MetricsService` and one prom-client `Registry`.
 */
@Module({
  imports: [MetricsRegistryModule],
  controllers: [MetricsController],
  providers: [MetricsAccessGuard, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
  exports: [MetricsRegistryModule],
})
export class MetricsModule {}
