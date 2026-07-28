import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClaimEnforcementService } from './rights-claim-enforcement.service';
import { RightsClaimsController } from './rights-claims.controller';
import { RightsClaimsService } from './rights-claims.service';

@Module({
  controllers: [RightsClaimsController],
  providers: [RightsClaimsService, RightsClaimEnforcementService, PrismaService, RolesGuard],
  exports: [RightsClaimsService, RightsClaimEnforcementService],
})
export class RightsClaimsModule {}
