import { Module } from '@nestjs/common';
import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { BookService } from './book.service';
import { BookController } from './book.controller';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [GeoBlockModule],
  controllers: [BookController],
  providers: [BookService, RelatedTaxonomyService],
  exports: [BookService],
})
export class BookModule {}
