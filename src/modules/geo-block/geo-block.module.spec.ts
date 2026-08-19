import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockRuleService } from './geo-block-rule.service';
import { GeoBlockModule } from './geo-block.module';
import { GeoIpCountryService } from './geo-ip-country.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test для фазы 12 (R0-04).
 *
 * Ветка runtime enforcement стоит выше ядра: она импортирует претензии и резолвер действующего
 * клиренса, но ни ядро, ни его потребители не имеют права импортировать её обратно. Убрать
 * `RightsClearanceModule` из `imports` — и первый кейс краснеет, потому что генерация правил
 * перестаёт резолвить резолвер; добавить сюда `RightsIntakeModule` — краснеет второй (ADR-003).
 */
describe('GeoBlockModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        GeoBlockModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(GeoBlockRuleService)).toBeDefined();
    expect(moduleRef.get(GeoIpCountryService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into the rights core', () => {
    const reachable = collectTransitiveImports(GeoBlockModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(GeoBlockModule);
    expect(reachable).not.toContain(RightsIntakeModule);
  });
});
