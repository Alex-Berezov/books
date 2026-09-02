import { Module } from '@nestjs/common';
import { TagsService } from './tags.service';
import { TagsController } from './tags.controller';
import { TaxonomyIndexabilityModule } from '../seo/indexability/taxonomy-indexability.module';
import { TagLockModule } from './tag-lock.module';

@Module({
  imports: [TaxonomyIndexabilityModule, TagLockModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
