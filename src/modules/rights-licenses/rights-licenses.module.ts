import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClearanceModule } from '../rights-clearance/rights-clearance.module';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import { RightsLicensesController } from './rights-licenses.controller';
import { RightsLicensesService } from './rights-licenses.service';

@Module({
  imports: [RightsClearanceModule],
  controllers: [RightsLicensesController],
  providers: [RightsLicensesService, RightsLicenseCoverageService, PrismaService, RolesGuard],
  exports: [RightsLicensesService, RightsLicenseCoverageService],
})
export class RightsLicensesModule {}
