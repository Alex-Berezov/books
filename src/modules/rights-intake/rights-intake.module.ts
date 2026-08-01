import { Module } from '@nestjs/common';
import { RightsIntakeService } from './rights-intake.service';
import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { RightsApprovalService } from './rights-approval.service';
import { RightsBookCreationService } from './rights-book-creation.service';
import { RightsReviewImportService } from './rights-review-import.service';
import { RightsReviewImportController } from './rights-review-import.controller';
import { RightsReviewImportValidator } from './rights-review-import.validator';
import { RightsIntakeController } from './rights-intake.controller';
import { RightsProfileController } from './rights-profile.controller';
import { RightsActionController } from './rights-action.controller';
import { RightsActionService } from './rights-action.service';
import { RightsMaterializationService } from './rights-materialization.service';
import { RightsProfileService } from './rights-profile.service';
import { RightsContentHashService } from './rights-content-hash.service';
import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';
import { ComponentTerritoryAggregationService } from './component-territory-aggregation.service';
import { PersonsModule } from '../persons/persons.module';
import { RightsLicensesModule } from '../rights-licenses/rights-licenses.module';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  imports: [PersonsModule, RightsLicensesModule],
  controllers: [
    RightsIntakeController,
    RightsReviewImportController,
    RightsProfileController,
    RightsActionController,
  ],
  providers: [
    RightsIntakeService,
    RightsIntakeManifestService,
    RightsReviewImportService,
    RightsReviewImportValidator,
    RightsMaterializationService,
    RightsProfileService,
    RightsActionService,
    RightsApprovalService,
    RightsBookCreationService,
    RightsContentHashService,
    TerritoryRegionAggregationService,
    ComponentTerritoryAggregationService,
    PrismaService,
  ],
  exports: [
    RightsIntakeService,
    RightsProfileService,
    RightsContentHashService,
    TerritoryRegionAggregationService,
    ComponentTerritoryAggregationService,
    RightsReviewImportService,
    RightsMaterializationService,
    RightsIntakeManifestService,
    RightsActionService,
  ],
})
export class RightsIntakeModule {}
