import { Module } from '@nestjs/common';
import { RightsClearanceModule } from '../rights-clearance/rights-clearance.module';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import { RightsLicensesController } from './rights-licenses.controller';
import { RightsLicensesService } from './rights-licenses.service';

@Module({
  imports: [RightsClearanceModule],
  controllers: [RightsLicensesController],
  providers: [RightsLicensesService, RightsLicenseCoverageService],
  exports: [RightsLicensesService, RightsLicenseCoverageService],
})
export class RightsLicensesModule {}
