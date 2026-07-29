import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
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

  it('is never imported back by RightsIntakeModule', () => {
    const imports = (Reflect.getMetadata('imports', RightsIntakeModule) as unknown[]) ?? [];
    expect(imports).not.toContain(RightsLawyerModule);
  });
});
