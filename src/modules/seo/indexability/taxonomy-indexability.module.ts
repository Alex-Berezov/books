import { Module } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from './taxonomy-indexability.service';

/**
 * Standalone module so both SeoModule and BookVersionModule can depend on the
 * recompute service without importing each other.
 */
@Module({
  providers: [TaxonomyIndexabilityService, PrismaService],
  exports: [TaxonomyIndexabilityService],
})
export class TaxonomyIndexabilityModule {}
