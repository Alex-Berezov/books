import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TaxonomyIndexabilitySchedulerService } from './taxonomy-indexability-scheduler.service';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';
import { BackgroundJobsRegistryModule } from '../../background-jobs/background-jobs-registry.module';

/**
 * Standalone module so SeoModule, BookVersionModule, CategoryModule and
 * TagsModule can depend on the recompute service without importing each other.
 */
@Module({
  imports: [BackgroundJobsRegistryModule, ConfigModule],
  providers: [TaxonomyIndexabilityService, TaxonomyIndexabilitySchedulerService],
  exports: [TaxonomyIndexabilityService, TaxonomyIndexabilitySchedulerService],
})
export class TaxonomyIndexabilityModule {}
