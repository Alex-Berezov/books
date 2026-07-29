import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { RightsAgentAdminController } from './rights-agent-admin.controller';
import { RightsAgentController } from './rights-agent.controller';
import { RightsAgentSubmissionService } from './rights-agent-submission.service';
import { RightsAgentTokenGuard } from './rights-agent-token.guard';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsAgentUploadRateLimitGuard } from './rights-agent-upload-rate-limit.guard';
import { RightsNotificationsController } from './rights-notifications.controller';
import { RightsNotificationsService } from './rights-notifications.service';

/**
 * `RightsIntakeModule` must never import this module back — that would be a cycle.
 * This is why the manual Phase 3 import path creates no notifications.
 */
@Module({
  imports: [RightsIntakeModule],
  controllers: [RightsAgentController, RightsAgentAdminController, RightsNotificationsController],
  providers: [
    RightsAgentTokenService,
    RightsAgentSubmissionService,
    RightsNotificationsService,
    RightsAgentTokenGuard,
    RightsAgentUploadRateLimitGuard,
    RolesGuard,
    PrismaService,
  ],
  exports: [RightsNotificationsService, RightsAgentTokenService],
})
export class RightsAgentModule {}
