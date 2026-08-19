import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsAgentModule } from '../rights-agent/rights-agent.module';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { RightsLawyerController } from './rights-lawyer.controller';
import { RightsLawyerReviewController } from './rights-lawyer-review.controller';
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
  imports: [RightsIntakeModule, RightsAgentModule],
  controllers: [RightsLawyerController, RightsLawyerReviewController],
  providers: [
    RightsLawyerService,
    RightsLawyerReviewService,
    RightsLegalOpinionService,
    RightsRiskAssessmentService,
    RolesGuard,
  ],
  exports: [RightsLawyerReviewService, RightsRiskAssessmentService, RightsLawyerService],
})
export class RightsLawyerModule {}
