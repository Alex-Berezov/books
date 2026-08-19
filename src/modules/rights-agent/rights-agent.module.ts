import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';
import { RightsAgentAdminController } from './rights-agent-admin.controller';
import { RightsAgentController } from './rights-agent.controller';
import { RightsAgentSubmissionService } from './rights-agent-submission.service';
import { RightsAgentTokenGuard } from './rights-agent-token.guard';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsAgentUploadRateLimitGuard } from './rights-agent-upload-rate-limit.guard';
import { RightsNotificationsController } from './rights-notifications.controller';
import { RightsNotificationsModule } from './rights-notifications.module';

/**
 * `RightsIntakeModule` must never import this module back — that would be a cycle.
 * Notifications themselves live in the leaf `RightsNotificationsModule`, which is what the
 * manual Phase 3 import path imports instead (WP-6.3).
 *
 * `RateLimitModule` is NOT global: it only exports `RATE_LIMITER`, so every module whose
 * providers inject it must import it explicitly (same as auth/comments/uploads/view-stats).
 * Without it `RightsAgentUploadRateLimitGuard` fails to resolve at bootstrap and takes the
 * whole application down.
 */
@Module({
  imports: [RightsIntakeModule, RateLimitModule, RightsNotificationsModule],
  controllers: [RightsAgentController, RightsAgentAdminController, RightsNotificationsController],
  providers: [
    RightsAgentTokenService,
    RightsAgentSubmissionService,
    RightsAgentTokenGuard,
    RightsAgentUploadRateLimitGuard,
    RolesGuard,
  ],
  // Модуль-лист реэкспортируется целиком: провайдер чужого модуля экспортировать нельзя,
  // а `rights-lawyer` и `rights-recheck` получают `RightsNotificationsService` отсюда.
  exports: [RightsNotificationsModule, RightsAgentTokenService],
})
export class RightsAgentModule {}
