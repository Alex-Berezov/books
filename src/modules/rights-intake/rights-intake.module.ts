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
import { RightsMaterializationService } from './rights-materialization.service';
import { RightsProfileService } from './rights-profile.service';
import { RightsContentHashService } from './rights-content-hash.service';
import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [RightsIntakeController, RightsReviewImportController, RightsProfileController],
  providers: [
    RightsIntakeService,
    RightsIntakeManifestService,
    RightsReviewImportService,
    RightsReviewImportValidator,
    RightsMaterializationService,
    RightsProfileService,
    RightsApprovalService,
    RightsBookCreationService,
    RightsContentHashService,
    TerritoryRegionAggregationService,
    PrismaService,
  ],
  exports: [
    RightsIntakeService,
    RightsProfileService,
    RightsContentHashService,
    TerritoryRegionAggregationService,
  ],
})
export class RightsIntakeModule {}
