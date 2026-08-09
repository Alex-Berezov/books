import { Module } from '@nestjs/common';
import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { BookService } from './book.service';
import { BookController } from './book.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [GeoBlockModule],
  controllers: [BookController],
  providers: [BookService, RelatedTaxonomyService, PrismaService, RolesGuard],
  exports: [BookService],
})
export class BookModule {}
