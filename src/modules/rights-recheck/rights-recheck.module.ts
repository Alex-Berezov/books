import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsAgentModule } from '../rights-agent/rights-agent.module';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { RightsLegalChangeController } from './rights-legal-change.controller';
import { RightsLegalChangeService } from './rights-legal-change.service';
import { RightsRecheckController } from './rights-recheck.controller';
import { RightsRecheckSchedulerService } from './rights-recheck-scheduler.service';
import { RightsRecheckService } from './rights-recheck.service';
import { RightsReviewChainService } from './rights-review-chain.service';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';

/**
 * Dependency direction is one-way on purpose:
 *   RightsRecheckModule → RightsIntakeModule, RightsAgentModule
 *   BookVersionModule   → RightsRecheckModule
 *
 * `RightsIntakeModule` and `RightsAgentModule` must NEVER import this module back — that
 * would be a cycle. It is also why `RightsContentHashService` does not create recheck tasks
 * itself: staleness is discovered by the scan (pull model), not pushed at detection time.
 *
 * `RightsAgentModule` is imported for `RightsNotificationsService`.
 */
@Module({
  imports: [BackgroundJobsRegistryModule, RightsIntakeModule, RightsAgentModule],
  controllers: [RightsRecheckController, RightsLegalChangeController],
  providers: [
    RightsRecheckService,
    RightsRecheckSchedulerService,
    RightsLegalChangeService,
    RightsReviewChainService,
    RolesGuard,
  ],
  exports: [RightsRecheckService, RightsRecheckSchedulerService, RightsReviewChainService],
})
export class RightsRecheckModule {}
