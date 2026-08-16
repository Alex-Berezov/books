import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsController } from '../metrics/metrics.controller';
import { MetricsModule } from '../metrics/metrics.module';
import { MetricsService } from '../metrics/metrics.service';
import { GeoBlockModule } from './geo-block.module';
import { GeoIpCountryService } from './geo-ip-country.service';

/**
 * LEGACY-206. Two invariants no other run can see, both of which break silently.
 *
 * First: one prom-client registry per application. Swap the `MetricsRegistryModule` import in
 * `geo-block.module.ts` for a local `providers: [MetricsService]` and `tsc`, every unit spec and
 * the e2e suite all stay green — while the counters grow in a registry that is not behind
 * `/api/metrics`, leaving both geo alert rules without data forever.
 *
 * Second: the threshold in the rule equals the threshold in the code. The duplication is
 * deliberate (the rule computes a ratio over a window, the service over the process lifetime),
 * but the numbers must match: once they drift, the admin endpoint reports `HEALTHY` at the very
 * moment a warning goes out to the channel, or the other way round.
 */
describe('geo metrics wiring (LEGACY-206)', () => {
  it('feeds the counters into the same registry that /api/metrics exposes', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        // Глобальный модуль, из которого MetricsAccessGuard берёт ModeratorRolesService.
        ModeratorRolesModule,
        MetricsModule,
        GeoBlockModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    const geo = moduleRef.get(GeoIpCountryService);
    // The registry is taken from `MetricsController` itself, not from a module chosen by this
    // spec: the controller is what answers `/api/metrics`, so whatever it holds is by definition
    // the registry Prometheus scrapes. Resolving it any other way lets a second private registry
    // inside either module satisfy the assertions while the endpoint serves nothing.
    const controller = moduleRef.get(MetricsController);
    const metrics = (controller as unknown as { metrics: MetricsService }).metrics;

    geo.resolveCountry({ 'cf-ipcountry': 'de' });
    geo.resolveCountry({ host: 'api.bibliaris.com' });

    expect(
      await metrics.getCounterValue('geo_country_resolved_total', { header: 'cf-ipcountry' }),
    ).toBe(1);
    expect(await metrics.getCounterValue('geo_country_unknown_total')).toBe(1);

    const exposed = await metrics.getMetrics();
    expect(exposed).toContain('geo_country_resolved_total{header="cf-ipcountry"} 1');
    expect(exposed).toContain('geo_country_unknown_total 1');

    await moduleRef.close();
  });

  it('keeps the alert threshold equal to DEGRADED_UNKNOWN_RATIO in the service', () => {
    const root = join(__dirname, '..', '..', '..');

    const source = readFileSync(
      join(root, 'src/modules/geo-block/geo-ip-country.service.ts'),
      'utf8',
    );
    const constant = source.match(/const DEGRADED_UNKNOWN_RATIO = ([\d.]+);/);
    expect(constant).not.toBeNull();

    const rules = readFileSync(join(root, 'configs/alert_rules.yml'), 'utf8');
    const degraded = rules.match(/alert: GeoCountrySourceDegraded[\s\S]*?> ([\d.]+)\n/);
    expect(degraded).not.toBeNull();

    expect(degraded?.[1]).toBe(constant?.[1]);
  });
});
