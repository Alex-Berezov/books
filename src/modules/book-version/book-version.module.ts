import { Module } from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { BookVersionController } from './book-version.controller';
import { PublicationGateService } from './publication-gate.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { RightsLicensesModule } from '../rights-licenses/rights-licenses.module';
import { RightsClaimsModule } from '../rights-claims/rights-claims.module';

@Module({
  imports: [RightsIntakeModule, GeoBlockModule, RightsLicensesModule, RightsClaimsModule],
  controllers: [BookVersionController],
  providers: [BookVersionService, PublicationGateService, PrismaService, RolesGuard],
  exports: [BookVersionService],
})
export class BookVersionModule {}
