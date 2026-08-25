import { Module } from '@nestjs/common';
import { SeoService } from './seo.service';
import { SeoController } from './seo.controller';
import { TaxonomyIndexabilityModule } from './indexability/taxonomy-indexability.module';
import { SystemPagesModule } from './system-pages/system-pages.module';
import { CategoryTreeModule } from '../category/category-tree.module';

@Module({
  imports: [TaxonomyIndexabilityModule, SystemPagesModule, CategoryTreeModule],
  controllers: [SeoController],
  providers: [SeoService],
  exports: [SeoService],
})
export class SeoModule {}
