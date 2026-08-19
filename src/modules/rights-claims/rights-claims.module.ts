import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsClaimEnforcementService } from './rights-claim-enforcement.service';
import { RightsClaimsController } from './rights-claims.controller';
import { RightsClaimsService } from './rights-claims.service';

@Module({
  controllers: [RightsClaimsController],
  providers: [RightsClaimsService, RightsClaimEnforcementService, RolesGuard],
  exports: [RightsClaimsService, RightsClaimEnforcementService],
})
export class RightsClaimsModule {}
