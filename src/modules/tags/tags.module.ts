import { Module } from '@nestjs/common';
import { TagsService } from './tags.service';
import { TagsController } from './tags.controller';
import { TaxonomyIndexabilityModule } from '../seo/indexability/taxonomy-indexability.module';

@Module({
  imports: [TaxonomyIndexabilityModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
