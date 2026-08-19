import { Module } from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { BookVersionController } from './book-version.controller';
import { PublicationGateService } from './publication-gate.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { RightsLicensesModule } from '../rights-licenses/rights-licenses.module';
import { RightsClaimsModule } from '../rights-claims/rights-claims.module';
import { RightsClearanceModule } from '../rights-clearance/rights-clearance.module';
import { RightsRecheckModule } from '../rights-recheck/rights-recheck.module';
import { RightsLawyerModule } from '../rights-lawyer/rights-lawyer.module';
import { TaxonomyIndexabilityModule } from '../seo/indexability/taxonomy-indexability.module';

@Module({
  imports: [
    TaxonomyIndexabilityModule,
    RightsIntakeModule,
    GeoBlockModule,
    RightsLicensesModule,
    RightsClaimsModule,
    RightsClearanceModule,
    RightsRecheckModule,
    RightsLawyerModule,
  ],
  controllers: [BookVersionController],
  providers: [BookVersionService, PublicationGateService, RolesGuard],
  exports: [BookVersionService],
})
export class BookVersionModule {}
