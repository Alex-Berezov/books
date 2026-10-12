import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MetricsRegistryModule } from '../metrics/metrics-registry.module';
import { RightsClaimsModule } from '../rights-claims/rights-claims.module';
import { RightsClearanceModule } from '../rights-clearance/rights-clearance.module';
import { RightsLicensesModule } from '../rights-licenses/rights-licenses.module';
import { GeoBlockController } from './geo-block.controller';
import { GeoBlockRuleService } from './geo-block-rule.service';
import { GeoCountrySourceController } from './geo-country-source.controller';
import { GeoIpCountryService } from './geo-ip-country.service';
import { VisitorCountryMiddleware } from './visitor-country.middleware';

@Module({
  // LEGACY-206: the module is imported instead of declaring a second provider — a local
  // `MetricsService` would mean two prom-client registries, with the geo counters growing in the
  // one `/api/metrics` does not expose. `MetricsRegistryModule` and not the full `MetricsModule`:
  // the latter brings `MetricsController` and a guard that needs `ModeratorRolesService`.
  // `RightsLicensesModule` — `LEGACY-029`: reading re-checks license coverage through
  // `RightsLicenseCoverageService`, both at runtime (`checkAccess`) and in the admin summary.
  // Rule *generation* deliberately does not ask about coverage — see the comment in
  // `generateRulesForVersion`.
  imports: [MetricsRegistryModule, RightsClaimsModule, RightsClearanceModule, RightsLicensesModule],
  controllers: [GeoBlockController, GeoCountrySourceController],
  providers: [GeoBlockRuleService, GeoIpCountryService],
  exports: [GeoBlockRuleService, GeoIpCountryService],
})
export class GeoBlockModule implements NestModule {
  // LEGACY-465: `X-Visitor-Country` is stripped on every route and trusted only from our front.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(VisitorCountryMiddleware).forRoutes('{*path}');
  }
}
