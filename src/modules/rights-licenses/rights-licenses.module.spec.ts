import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import { RightsLicensesModule } from './rights-licenses.module';
import { RightsLicensesService } from './rights-licenses.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test для фазы 15 (R0-04).
 *
 * Модуль импортируется ядром (`RightsIntakeModule`), поэтому обратной зависимости иметь не может:
 * добавить `RightsIntakeModule` в `imports` — и второй кейс краснеет. Первый кейс ловит
 * незарегистрированный провайдер: `RolesGuard` тянет `ConfigService` и `PrismaService`, а покрытие
 * лицензий — `RightsClearanceModule`; убрать любой из них из метаданных модуля, и container не
 * соберётся (ADR-003).
 */
describe('RightsLicensesModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        RightsLicensesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsLicensesService)).toBeDefined();
    expect(moduleRef.get(RightsLicenseCoverageService)).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic and never reaches back into the rights core', () => {
    const reachable = collectTransitiveImports(RightsLicensesModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(RightsLicensesModule);
    expect(reachable).not.toContain(RightsIntakeModule);
  });
});
