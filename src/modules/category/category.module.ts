import { Module } from '@nestjs/common';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';
import { TaxonomyIndexabilityModule } from '../seo/indexability/taxonomy-indexability.module';

@Module({
  imports: [TaxonomyIndexabilityModule],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [CategoryService],
})
export class CategoryModule {}
