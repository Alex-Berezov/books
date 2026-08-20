import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { BookService } from '../book/book.service';
import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { PagesService } from '../pages/pages.service';
import { LanguageResolverGuard } from '../../common/guards/language-resolver.guard';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { CategoryService } from '../category/category.service';
import { TagsService } from '../tags/tags.service';
import { AuthorService } from '../author/author.service';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { CategoryTreeModule } from '../category/category-tree.module';

@Module({
  // ⚠️ `CategoryTreeModule` здесь не по своей воле: `PublicModule` объявляет
  // собственный экземпляр `CategoryService` (`LEGACY-260`), а тот с 20.08.2026
  // зависит от подъёма по дереву (`LEGACY-263`). Уйдёт дубль провайдера —
  // уйдёт и эта строка.
  imports: [GeoBlockModule, CategoryTreeModule],
  controllers: [PublicController],
  providers: [
    BookService,
    RelatedTaxonomyService,
    PagesService,
    CategoryService,
    TagsService,
    AuthorService,
    LanguageResolverGuard,
    LangParamPipe,
  ],
})
export class PublicModule {}
