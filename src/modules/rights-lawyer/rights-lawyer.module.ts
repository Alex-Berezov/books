import { Module } from '@nestjs/common';
import { RightsAgentModule } from '../rights-agent/rights-agent.module';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';
import { RightsLawyerController } from './rights-lawyer.controller';
import { RightsLawyerReviewController } from './rights-lawyer-review.controller';
import { RightsLawyerExpirySchedulerService } from './rights-lawyer-expiry-scheduler.service';
import { RightsLawyerReviewService } from './rights-lawyer-review.service';
import { RightsLawyerService } from './rights-lawyer.service';
import { RightsLegalOpinionService } from './rights-legal-opinion.service';
import { RightsRiskAssessmentService } from './rights-risk-assessment.service';

/**
 * Dependency direction is one-way on purpose:
 *   RightsLawyerModule → RightsIntakeModule, RightsAgentModule
 *   BookVersionModule  → RightsLawyerModule
 *
 * `RightsIntakeModule` must NEVER import this module — that would be a cycle. It is also why
 * `RightsApprovalService` does not call any Phase 19 service: it reads the denormalised snapshot
 * on `RightsProfile` and recomputes the risk with the pure `computeRiskAssessment` helper
 * (ADR-003).
 *
 * `RightsAgentModule` is imported for `RightsNotificationsService`.
 * `rights-claims` is deliberately NOT imported: claims are only read through a delegate.
 */
@Module({
  imports: [RightsIntakeModule, RightsAgentModule, BackgroundJobsRegistryModule],
  controllers: [RightsLawyerController, RightsLawyerReviewController],
  providers: [
    RightsLawyerService,
    RightsLawyerReviewService,
    RightsLegalOpinionService,
    RightsRiskAssessmentService,
    RightsLawyerExpirySchedulerService,
  ],
  exports: [RightsLawyerReviewService, RightsRiskAssessmentService, RightsLawyerService],
})
export class RightsLawyerModule {}
