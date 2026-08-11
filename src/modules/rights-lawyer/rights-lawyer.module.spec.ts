import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { RightsLawyerModule } from './rights-lawyer.module';
import { RightsLawyerReviewService } from './rights-lawyer-review.service';
import { RightsLawyerService } from './rights-lawyer.service';
import { RightsLegalOpinionService } from './rights-legal-opinion.service';
import { RightsRiskAssessmentService } from './rights-risk-assessment.service';

/**
 * DI smoke test: the container must compile with the real module graph, and the dependency
 * direction must stay one-way. Removing `RightsAgentModule` from the imports of
 * `RightsLawyerModule` makes the first case fail, because `RightsNotificationsService` would
 * no longer resolve; adding `RightsLawyerModule` to `RightsIntakeModule` makes the second
 * case fail, because the cycle would be visible in its metadata (ADR-003).
 */
describe('RightsLawyerModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), RightsLawyerModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsLawyerService)).toBeDefined();
    expect(moduleRef.get(RightsLawyerReviewService)).toBeDefined();
    expect(moduleRef.get(RightsLegalOpinionService)).toBeDefined();
    expect(moduleRef.get(RightsRiskAssessmentService)).toBeDefined();

    await moduleRef.close();
  });

  /**
   * Собственный граф модуля — та же проверка, что у шести соседних спек:
   * замыкание не содержит ни сам модуль (ацикличность), ни `undefined`
   * (след циклического `require`, при котором ссылка в `imports` не успевает
   * инициализироваться).
   */
  it('держит собственный граф ацикличным', () => {
    const reachable = collectTransitiveImports(RightsLawyerModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(RightsLawyerModule);
  });

  /**
   * ⚠️ Односторонность проверялась прямыми `imports` одного модуля и потому
   * ловила только цикл длиной 2. Цикл через посредника —
   * `RightsIntakeModule → X → RightsLawyerModule` — проходил незамеченным,
   * хотя ADR-003 запрещает и его (`LEGACY-042`).
   *
   * `undefined` здесь намеренно **не** проверяется: то же утверждение на том же
   * корне уже делает `rights-intake.module.spec.ts`, и дубль сообщал бы о
   * циклическом `require` в чужом замыкании как о проблеме этого модуля.
   */
  it('никогда не достижим из RightsIntakeModule — ни прямо, ни через посредника', () => {
    expect(collectTransitiveImports(RightsIntakeModule)).not.toContain(RightsLawyerModule);
  });
});
