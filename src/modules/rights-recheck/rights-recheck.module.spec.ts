import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsRecheckModule } from './rights-recheck.module';
import { RightsRecheckSchedulerService } from './rights-recheck-scheduler.service';
import { RightsRecheckService } from './rights-recheck.service';
import { RightsReviewChainService } from './rights-review-chain.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * DI smoke test: the container must compile with the real module graph.
 *
 * Phase 17 shipped without such a test and an unregistered `RateLimitModule` took down
 * 44 e2e suites on CI. This test catches the same class of failure at unit-test speed —
 * removing `RightsAgentModule` from the imports of `RightsRecheckModule` makes it fail,
 * because `RightsNotificationsService` would no longer resolve.
 */
describe('RightsRecheckModule', () => {
  it('compiles the dependency container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, ConfigModule.forRoot({ isGlobal: true }), RightsRecheckModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RightsRecheckService)).toBeDefined();
    expect(moduleRef.get(RightsRecheckSchedulerService)).toBeDefined();
    expect(moduleRef.get(RightsReviewChainService)).toBeDefined();

    await moduleRef.close();
  });
});
