import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { RightsClaimEnforcementService } from './rights-claim-enforcement.service';
import { RightsClaimsModule } from './rights-claims.module';
import { RightsClaimsService } from './rights-claims.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test для фазы 16 (R0-04).
 *
 * Модуль не импортирует ничего: претензии обязаны оставаться листом графа, потому что их
 * импортирует `GeoBlockModule` — ветка runtime enforcement. Добавить сюда `GeoBlockModule`
 * (или что-либо, что до него дотягивается) — и второй кейс краснеет. Первый кейс ловит
 * незарегистрированный провайдер: `RightsClaimsController` тянет `RolesGuard` (его Nest
 * разрешает сам, из `module.injectables`, — в `providers` его нет с `LEGACY-259`), а тот —
 * `ConfigService` и `PrismaService` (ADR-003).
 */
describe('RightsClaimsModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        RightsClaimsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsClaimsService)).toBeDefined();
    expect(moduleRef.get(RightsClaimEnforcementService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into geo-block', () => {
    const reachable = collectTransitiveImports(RightsClaimsModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(RightsClaimsModule);
    expect(reachable).not.toContain(GeoBlockModule);
  });
});
