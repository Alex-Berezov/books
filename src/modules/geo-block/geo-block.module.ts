import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockController } from './geo-block.controller';
import { GeoBlockRuleService } from './geo-block-rule.service';
import { GeoIpCountryService } from './geo-ip-country.service';

@Module({
  controllers: [GeoBlockController],
  providers: [GeoBlockRuleService, GeoIpCountryService, PrismaService, RolesGuard],
  exports: [GeoBlockRuleService, GeoIpCountryService],
})
export class GeoBlockModule {}
