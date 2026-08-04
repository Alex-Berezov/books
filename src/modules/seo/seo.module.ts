import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SeoService } from './seo.service';
import { SeoController } from './seo.controller';
import { TaxonomyIndexabilityModule } from './indexability/taxonomy-indexability.module';

@Module({
  imports: [TaxonomyIndexabilityModule],
  controllers: [SeoController],
  providers: [SeoService, PrismaService, RolesGuard],
  exports: [SeoService],
})
export class SeoModule {}
