import { Module } from '@nestjs/common';
import { RightsClaimEnforcementService } from './rights-claim-enforcement.service';
import { RightsClaimsController } from './rights-claims.controller';
import { RightsClaimsService } from './rights-claims.service';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

@Module({
  // Снимок лицензий, гасимый блокировкой по претензии, уходит в журнал
  // административных действий: он переживает удаление версии (`LEGACY-180`).
  imports: [AdminAuditModule],
  controllers: [RightsClaimsController],
  providers: [RightsClaimsService, RightsClaimEnforcementService],
  exports: [RightsClaimsService, RightsClaimEnforcementService],
})
export class RightsClaimsModule {}
