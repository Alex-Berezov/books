import { Module } from '@nestjs/common';
import { BookService } from './book.service';
import { BookController } from './book.controller';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { RelatedTaxonomyModule } from '../seo/related-taxonomy/related-taxonomy.module';
import { AuthorModule } from '../author/author.module';

@Module({
  imports: [GeoBlockModule, RelatedTaxonomyModule, AuthorModule],
  controllers: [BookController],
  providers: [BookService],
  exports: [BookService],
})
export class BookModule {}
