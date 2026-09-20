import { Module } from '@nestjs/common';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';
import { TaxonomyIndexabilityModule } from '../seo/indexability/taxonomy-indexability.module';
import { CategoryTreeModule } from './category-tree.module';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

@Module({
  imports: [TaxonomyIndexabilityModule, CategoryTreeModule, AdminAuditModule],
  controllers: [CategoryController],
  providers: [CategoryService],
  exports: [CategoryService],
})
export class CategoryModule {}
