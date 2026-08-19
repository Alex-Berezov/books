import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaService } from '../../prisma/prisma.service';
import { ComponentTerritoryAggregationService } from './component-territory-aggregation.service';
import { RightsActionService } from './rights-action.service';
import { RightsApprovalService } from './rights-approval.service';
import { RightsBookCreationService } from './rights-book-creation.service';
import { RightsContentHashService } from './rights-content-hash.service';
import { RightsFilesService } from './rights-files.service';
import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { RightsIntakeModule } from './rights-intake.module';
import { RightsIntakeService } from './rights-intake.service';
import { RightsMaterializationService } from './rights-materialization.service';
import { RightsProfileService } from './rights-profile.service';
import { RightsReviewImportService } from './rights-review-import.service';
import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test для ядра системы прав (R0-04).
 *
 * Ядро — единственный модуль прав, который импортируют почти все остальные, поэтому цикл здесь
 * ломает bootstrap целиком, а не одну ветку. Первый кейс ловит незарегистрированный провайдер
 * (убрать любой сервис из `providers` или `RightsFileStorageModule` из `imports` — тест краснеет),
 * второй ловит цикл: `RightsAgentModule`, `RightsLawyerModule` и `RightsRecheckModule` импортируют
 * ядро, поэтому ядро не имеет права дотянуться до них ни напрямую, ни транзитивно (ADR-003).
 */
describe('RightsIntakeModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        RightsIntakeModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsIntakeService)).toBeDefined();
    expect(moduleRef.get(RightsIntakeManifestService)).toBeDefined();
    expect(moduleRef.get(RightsReviewImportService)).toBeDefined();
    expect(moduleRef.get(RightsMaterializationService)).toBeDefined();
    expect(moduleRef.get(RightsProfileService)).toBeDefined();
    expect(moduleRef.get(RightsActionService)).toBeDefined();
    expect(moduleRef.get(RightsApprovalService)).toBeDefined();
    expect(moduleRef.get(RightsBookCreationService)).toBeDefined();
    expect(moduleRef.get(RightsFilesService)).toBeDefined();
    expect(moduleRef.get(TerritoryRegionAggregationService)).toBeDefined();
    expect(moduleRef.get(ComponentTerritoryAggregationService)).toBeDefined();
    expect(moduleRef.get(RightsContentHashService, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it('keeps the module graph acyclic', () => {
    const reachable = collectTransitiveImports(RightsIntakeModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(RightsIntakeModule);
  });
});
