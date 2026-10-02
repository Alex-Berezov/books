import { Module } from '@nestjs/common';
import { SeoService } from './seo.service';
import { SeoController } from './seo.controller';
import { TaxonomyIndexabilityModule } from './indexability/taxonomy-indexability.module';
import { SystemPagesModule } from './system-pages/system-pages.module';
import { CategoryTreeModule } from '../category/category-tree.module';
import { AuthorModule } from '../author/author.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [
    TaxonomyIndexabilityModule,
    SystemPagesModule,
    CategoryTreeModule,
    AuthorModule,
    GeoBlockModule,
  ],
  controllers: [SeoController],
  providers: [SeoService],
  exports: [SeoService],
})
export class SeoModule {}
