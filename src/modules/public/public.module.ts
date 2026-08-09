import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { BookService } from '../book/book.service';
import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { PagesService } from '../pages/pages.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LanguageResolverGuard } from '../../common/guards/language-resolver.guard';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { CategoryService } from '../category/category.service';
import { TagsService } from '../tags/tags.service';
import { AuthorService } from '../author/author.service';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [GeoBlockModule],
  controllers: [PublicController],
  providers: [
    BookService,
    RelatedTaxonomyService,
    PagesService,
    CategoryService,
    TagsService,
    AuthorService,
    PrismaService,
    LanguageResolverGuard,
    LangParamPipe,
  ],
})
export class PublicModule {}
