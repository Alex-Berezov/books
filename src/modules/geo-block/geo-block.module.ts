import { Module } from '@nestjs/common';
import { MetricsRegistryModule } from '../metrics/metrics-registry.module';
import { RightsClaimsModule } from '../rights-claims/rights-claims.module';
import { RightsClearanceModule } from '../rights-clearance/rights-clearance.module';
import { GeoBlockController } from './geo-block.controller';
import { GeoBlockRuleService } from './geo-block-rule.service';
import { GeoCountrySourceController } from './geo-country-source.controller';
import { GeoIpCountryService } from './geo-ip-country.service';

@Module({
  // LEGACY-206: the module is imported instead of declaring a second provider — a local
  // `MetricsService` would mean two prom-client registries, with the geo counters growing in the
  // one `/api/metrics` does not expose. `MetricsRegistryModule` and not the full `MetricsModule`:
  // the latter brings `MetricsController` and a guard that needs `ModeratorRolesService`.
  imports: [MetricsRegistryModule, RightsClaimsModule, RightsClearanceModule],
  controllers: [GeoBlockController, GeoCountrySourceController],
  providers: [GeoBlockRuleService, GeoIpCountryService],
  exports: [GeoBlockRuleService, GeoIpCountryService],
})
export class GeoBlockModule {}
