import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { TaxonomyIndexabilitySchedulerService } from './taxonomy-indexability-scheduler.service';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';

/**
 * Standalone module so SeoModule, BookVersionModule, CategoryModule and
 * TagsModule can depend on the recompute service without importing each other.
 */
@Module({
  imports: [ConfigModule],
  providers: [TaxonomyIndexabilityService, TaxonomyIndexabilitySchedulerService, PrismaService],
  exports: [TaxonomyIndexabilityService],
})
export class TaxonomyIndexabilityModule {}
